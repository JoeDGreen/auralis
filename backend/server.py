import asyncio
import json
import logging
import uuid
import os
import http
from websockets import serve, exceptions

logging.basicConfig(level=logging.INFO)

# Map room_name -> { "host": client_id, "clients": { client_id: {"name": str, "role": "host"|"speaker"|"audience", "ws": websocket} } }
rooms = {}
clients_global = {} # client_id -> root room name for fast cleanup

async def send_room_update():
    # Broadcast available rooms to everyone who hasn't joined a room
    room_list = [{"name": r, "count": len(rooms[r]['clients'])} for r in rooms]
    for cid, room_name in clients_global.items():
        if room_name is None: # Still in lobby
            found = False
            for r, data in rooms.items():
                if cid in data['clients']:
                    found = True
            if not found:
                # Find their websocket (it's stored in a messy way since they aren't in a room yet, let's keep a lobby list)
                pass

# Let's clean up state management
lobby_clients = {} # cid -> ws

async def broadcast_lobby():
    room_list = [{"name": r, "count": len(rooms[r]['clients'])} for r in rooms]
    msg = json.dumps({'type': 'room_list', 'rooms': room_list})
    for ws in lobby_clients.values():
        try:
            await ws.send(msg)
        except:
            pass

async def broadcast_room_state(room_name):
    if room_name not in rooms: return
    
    participants = []
    for cid, cdata in rooms[room_name]['clients'].items():
        participants.append({
            "id": cid,
            "name": cdata["name"],
            "role": cdata["role"]
        })
        
    msg = json.dumps({'type': 'room_state', 'participants': participants})
    for cid, cdata in rooms[room_name]['clients'].items():
        try:
            await cdata['ws'].send(msg)
        except:
            pass

async def handler(*args):
    websocket = args[0]
    client_id = str(uuid.uuid4())
    lobby_clients[client_id] = websocket
    logging.info(f"Client {client_id} connected to Lobby.")
    
    await websocket.send(json.dumps({'type': 'init', 'id': client_id}))
    await broadcast_lobby()
    
    current_room = None

    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get('type')
            
            if msg_type == 'create_room':
                room_name = data.get('room')
                user_name = data.get('name', 'Host')
                
                if room_name not in rooms:
                    del lobby_clients[client_id]
                    current_room = room_name
                    
                    rooms[room_name] = {
                        "host": client_id,
                        "clients": {
                            client_id: {"name": user_name, "role": "host", "ws": websocket}
                        }
                    }
                    await broadcast_lobby()
                    await broadcast_room_state(room_name)
                    
            elif msg_type == 'join_room':
                room_name = data.get('room')
                user_name = data.get('name', 'Listener')
                
                if room_name in rooms:
                    if client_id in lobby_clients:
                        del lobby_clients[client_id]
                    current_room = room_name
                    
                    rooms[room_name]['clients'][client_id] = {"name": user_name, "role": "audience", "ws": websocket}
                    
                    # Tell existing speakers/host to negotiate WebRTC for the new participant
                    for cid, cdata in rooms[room_name]['clients'].items():
                        if cid != client_id and cdata['role'] in ['host', 'speaker']:
                            await cdata['ws'].send(json.dumps({'type': 'user_joined_audience', 'new_client_id': client_id}))
                            
                    await broadcast_lobby()
                    await broadcast_room_state(room_name)

            elif msg_type == 'raise_hand':
                if current_room and current_room in rooms:
                    host_id = rooms[current_room]['host']
                    host_ws = rooms[current_room]['clients'][host_id]['ws']
                    user_name = rooms[current_room]['clients'][client_id]['name']
                    await host_ws.send(json.dumps({'type': 'hand_raised', 'client_id': client_id, 'name': user_name}))
                    
            elif msg_type == 'approve_speaker':
                target_id = data.get('target')
                if current_room and current_room in rooms and client_id == rooms[current_room]['host']:
                    if target_id in rooms[current_room]['clients']:
                        rooms[current_room]['clients'][target_id]['role'] = 'speaker'
                        
                        target_ws = rooms[current_room]['clients'][target_id]['ws']
                        await target_ws.send(json.dumps({'type': 'approved_speaker'}))
                        
                        # Everyone needs to negotiate with the new speaker
                        for cid, cdata in rooms[current_room]['clients'].items():
                            if cid != target_id:
                                await cdata['ws'].send(json.dumps({'type': 'new_speaker', 'speaker_id': target_id}))
                        
                        await broadcast_room_state(current_room)
            
            else:
                # WebRTC Signaling (Offers, Answers, ICE)
                target = data.get('target')
                if current_room and target and target in rooms.get(current_room, {}).get('clients', {}):
                    data['sender'] = client_id
                    await rooms[current_room]['clients'][target]['ws'].send(json.dumps(data))
                
    except exceptions.ConnectionClosed:
        pass
    finally:
        logging.info(f"Client {client_id} disconnected.")
        if client_id in lobby_clients:
            del lobby_clients[client_id]
            
        if current_room and current_room in rooms:
            if client_id in rooms[current_room]['clients']:
                del rooms[current_room]['clients'][client_id]
            
            # Clean up empty rooms, or reassign host? For simplicity, if host leaves, room closes (or everyone kicked out)
            if len(rooms[current_room]['clients']) == 0 or current_room not in rooms or client_id == rooms[current_room].get('host'):
                # Room closes
                for cid, cdata in rooms[current_room]['clients'].items():
                    try:
                        await cdata['ws'].send(json.dumps({'type': 'room_closed'}))
                    except: pass
                del rooms[current_room]
            else:
                for cid, cdata in rooms[current_room]['clients'].items():
                    try:
                        await cdata['ws'].send(json.dumps({'type': 'user_left', 'client_id': client_id}))
                    except: pass
                await broadcast_room_state(current_room)
                
        await broadcast_lobby()

async def process_request(*args):
    request = dict(args[1]) if hasattr(args[1], 'items') else getattr(args[1], 'headers', args[1])
    conn_header = request.get('Connection', '') if hasattr(request, 'get') else request.get('Connection', '')
    if 'upgrade' not in str(conn_header).lower():
        return (http.HTTPStatus.OK, [], b"Auralis Server Running\n")
    return None

async def main():
    HOST = "0.0.0.0"
    PORT = int(os.environ.get("PORT", 8765))
    server = await serve(handler, HOST, PORT, process_request=process_request)
    logging.info(f"Auralis Signaling server started on ws://{HOST}:{PORT}")
    await server.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())






