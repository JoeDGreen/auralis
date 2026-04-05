const politeStatus = document.getElementById('status-polite');
const assertiveStatus = document.getElementById('status-assertive');
const visibleStatus = document.getElementById('visible-status');

const lobbyTitle = document.getElementById('lobby-title');
const roomTitle = document.getElementById('room-title');

const lobbySection = document.getElementById('lobby-section');
const roomSection = document.getElementById('room-section');
const roomsList = document.getElementById('rooms-list');
const usernameInput = document.getElementById('username-input');
const createRoomInput = document.getElementById('new-room-name');
const createRoomBtn = document.getElementById('createRoomBtn');

const speakersList = document.getElementById('speakers-list');
const audienceList = document.getElementById('audience-list');
const raiseHandBtn = document.getElementById('raiseHandBtn');
const muteBtn = document.getElementById('muteBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const hostRequests = document.getElementById('host-requests');

let socket;
let localStream = null;
let peerConnections = {};
let myId = null;
let myName = "User";
let myRole = "lobby";
let currentRoom = null;
let isMuted = false;

// 1. REAL WORLD NETWORKING (TURN SERVERS)
// IceServers now includes Google's free STUN (finds your IP) AND a placeholder 
// for Twilio/Metered TURN (bounces your traffic past firewalls when STUN fails).
const configuration = { 
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // STUN is free
        { 
            urls: 'turn:global.turn.twilio.com:3478?transport=udp', // TURN is paid/metered
            username: 'joe.derrick.green@gmail.com', 
            credential: 'Lakers2479163930662' 
        }
    ] 
};

// 2. AUDIO CUES (EARCONS) FOR ACCESSIBILITY via Web Audio API 
// These play tiny sounds without needing external wav files.
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playEarcon(type) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    if (type === 'join') {
        // Happy ascending "bloop"
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(400, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.15);
        gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        oscillator.start(); oscillator.stop(audioCtx.currentTime + 0.15);
    } else if (type === 'leave') {
        // Sad descending "bloop"
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(600, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.15);
        gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        oscillator.start(); oscillator.stop(audioCtx.currentTime + 0.15);
    } else if (type === 'raise_hand') {
        // Bright "Chime"
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.6);
        oscillator.start(); oscillator.stop(audioCtx.currentTime + 0.6);
    } else if (type === 'mute') {
        // Sharp "Click"
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(200, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);
        oscillator.start(); oscillator.stop(audioCtx.currentTime + 0.05);
    }
}

function announceStatus(message, isUrgent = false) {
    if (isUrgent) {
        assertiveStatus.textContent = '';
        setTimeout(() => assertiveStatus.textContent = message, 50);
    } else {
        politeStatus.textContent = '';
        setTimeout(() => politeStatus.textContent = message, 50);
    }
}

async function connectWebSocket() {
    socket = new WebSocket('wss://auralis-x8vf.onrender.com');
    socket.onopen = () => {
        announceStatus("Connected to Lobby network.");
        visibleStatus.textContent = "Status: Connected to Lobby.";
    };
    socket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        const { type } = message;

        if (type === 'init') {
            myId = message.id;
        } else if (type === 'room_list') {
            updateLobbyRooms(message.rooms);
        } else if (type === 'room_state') {
            updateRoomUI(message.participants);
        } else if (type === 'user_joined_audience') {
            const peerId = message.new_client_id;
            const pc = createNewPeerConnection(peerId);
            if (localStream) {
                localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.send(JSON.stringify({ target: peerId, type: 'offer', sdp: offer.sdp }));
        } else if (type === 'hand_raised') {
            if (myRole === 'host') {
                playEarcon('raise_hand'); 
                announceStatus(`${message.name} wants to speak.`);
                const d = document.createElement('div');
                d.textContent = `${message.name} raised hand!`;
                const btn = document.createElement('button');
                btn.textContent = "Allow to Speak";
                btn.onclick = () => {
                    socket.send(JSON.stringify({ type: 'approve_speaker', target: message.client_id }));
                    d.remove();
                };
                d.appendChild(btn);
                hostRequests.appendChild(d);
            }
        } else if (type === 'approved_speaker') {
            announceStatus("You are now a speaker! Fetching microphone...", true);
            myRole = "speaker";
            await acquireMicAndBroadcast();
        } else if (type === 'offer') {
            const peerId = message.sender;
            let pc = peerConnections[peerId] || createNewPeerConnection(peerId);
            await pc.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.send(JSON.stringify({ target: peerId, type: 'answer', sdp: answer.sdp }));
        } else if (type === 'answer') {
            const peerId = message.sender;
            if (peerConnections[peerId]) {
                await peerConnections[peerId].setRemoteDescription(new RTCSessionDescription(message));
            }
        } else if (type === 'candidate') {
            const peerId = message.sender;
            if (peerConnections[peerId]) {
                await peerConnections[peerId].addIceCandidate(new RTCIceCandidate(message.candidate));
            }
        } else if (type === 'user_left') {
            if (peerConnections[message.client_id]) {
                peerConnections[message.client_id].close();
                delete peerConnections[message.client_id];
            }
        } else if (type === 'room_closed') {
             announceStatus("The room was closed by the host.", true);
             leaveRoomLogic();
        }
    };

    socket.onclose = () => {
        visibleStatus.textContent = "Status: Disconnected";
    };
}

function updateLobbyRooms(rooms) {
    roomsList.innerHTML = '';
    if (rooms.length === 0) {
        roomsList.innerHTML = '<li>No active rooms. Create one!</li>';
        return;
    }
    
    rooms.forEach(r => {
        const li = document.createElement('li');
        li.textContent = `${r.name} (${r.count} participants) `;
        const btn = document.createElement('button');
        btn.textContent = "Join Room";
        btn.className = "secondary-btn";
        btn.onclick = () => joinRoom(r.name);
        li.appendChild(btn);
        roomsList.appendChild(li);
    });
}

function updateRoomUI(participants) {
    speakersList.innerHTML = '';
    audienceList.innerHTML = '';
    
    participants.forEach(p => {
        const li = document.createElement('li');
        li.textContent = p.name;
        if (p.role === 'host') li.textContent += " (Host)";
        
        if (p.role === 'host' || p.role === 'speaker') {
            speakersList.appendChild(li);
        } else {
            audienceList.appendChild(li);
        }
        if (p.id === myId) myRole = p.role;
    });

    if (myRole === 'host' || myRole === 'speaker') {
        raiseHandBtn.style.display = 'none';
        muteBtn.style.display = 'block';
    } else {
        raiseHandBtn.style.display = 'block';
        raiseHandBtn.textContent = "Raise Hand to Speak";
        muteBtn.style.display = 'none';
    }
}

// 3. FOCUS MANAGEMENT POLISH
function transitionToRoom(roomName) {
    lobbySection.style.display = 'none';
    roomSection.style.display = 'block';
    roomTitle.textContent = "Room: " + roomName;
    
    // Play Earcon & Force Screen Reader Focus strictly to the Room Title
    playEarcon('join');
    roomTitle.focus(); 
}

async function joinRoom(roomName) {
    myName = usernameInput.value || "Listener";
    currentRoom = roomName;
    myRole = "audience";
    
    transitionToRoom(roomName);
    announceStatus(`Joined Room ${roomName} as a listener.`);

    socket.send(JSON.stringify({ type: 'join_room', room: currentRoom, name: myName }));
}

createRoomBtn.addEventListener('click', async () => {
    myName = usernameInput.value || "Host";
    currentRoom = createRoomInput.value.trim();
    if (!currentRoom) { alert("Please enter a room name"); return; }
    
    myRole = "host";
    
    try {
        announceStatus("Requesting microphone for Host role.");
        await acquireMicAndBroadcast(false); 
        
        transitionToRoom(currentRoom);
        
        socket.send(JSON.stringify({ type: 'create_room', room: currentRoom, name: myName }));
        announceStatus(`Created and Host of Room ${currentRoom}.`);
    } catch (e) {
        announceStatus("Failed to get microphone. Cannot host room.");
    }
});

raiseHandBtn.addEventListener('click', () => {
    if (myRole === 'audience') {
        socket.send(JSON.stringify({ type: 'raise_hand' }));
        raiseHandBtn.textContent = "Hand Raised (Waiting for Host...)";
        announceStatus("Raised hand. Waiting for host approval.");
    }
});

muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    
    playEarcon('mute'); // Adding earcon feedback for mute toggling
    
    isMuted = !isMuted;
    localStream.getAudioTracks()[0].enabled = !isMuted;
    
    if (isMuted) {
        muteBtn.setAttribute('aria-pressed', 'false');
        muteBtn.textContent = "Unmute Microphone (Currently Muted)";
        announceStatus("Microphone Muted");
    } else {
        muteBtn.setAttribute('aria-pressed', 'true');
        muteBtn.textContent = "Mute Microphone (Currently LIVE)";
        announceStatus("Microphone live");
    }
});

leaveRoomBtn.addEventListener('click', leaveRoomLogic);

function leaveRoomLogic() {
    playEarcon('leave'); // Play sad leave sound
    
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
    document.getElementById('remote-audios').innerHTML = '';
    hostRequests.innerHTML = '';
    
    socket.close();
    connectWebSocket();
    
    lobbySection.style.display = 'block';
    roomSection.style.display = 'none';
    currentRoom = null;
    myRole = "lobby";
    announceStatus(`Left room and returned to Lobby.`);
    
    // Strict Focus Management returning to Lobby
    lobbyTitle.focus();
}

async function acquireMicAndBroadcast(shouldNegotiateWithEveryone = true) {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStream.getAudioTracks()[0].enabled = true;
    isMuted = false;
    
    muteBtn.setAttribute('aria-pressed', 'true');
    muteBtn.textContent = "Mute Microphone (Currently LIVE)";
    muteBtn.style.display = 'block';
    raiseHandBtn.style.display = 'none';
    
    if (shouldNegotiateWithEveryone) {
        for (const [peerId, pc] of Object.entries(peerConnections)) {
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.send(JSON.stringify({ target: peerId, type: 'offer', sdp: offer.sdp }));
        }
    }
}

function createNewPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection(configuration);
    
    pc.onicecandidate = ({candidate}) => {
        if (candidate && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ target: remotePeerId, type: 'candidate', candidate }));
        }
    };
    pc.ontrack = (event) => {
        let remoteAudio = document.createElement('audio');
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.autoplay = true;
        document.getElementById('remote-audios').appendChild(remoteAudio);
    };
    peerConnections[remotePeerId] = pc;
    return pc;
}

connectWebSocket();
