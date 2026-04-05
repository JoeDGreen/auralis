import tkinter as tk
import subprocess
import os

process = None
# Flag to prevent command prompt window from flashing when starting the server process
CREATE_NO_WINDOW = 0x08000000

def start_server():
    global process
    if process is None or process.poll() is not None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        server_path = os.path.join(script_dir, "backend", "server.py")
        
        # Start the Python server hidden in the background
        process = subprocess.Popen(["python", server_path], creationflags=CREATE_NO_WINDOW)
        
        status_var.set("Server Status: RUNNING")
        start_btn.config(state=tk.DISABLED)
        stop_btn.config(state=tk.NORMAL)
        
        # Change window title so Screen Reader reads the new state
        root.title("Server Manager - Running")
        
        # Move focus to the Stop button
        stop_btn.focus_set()

def stop_server():
    global process
    if process is not None and process.poll() is None:
        process.terminate()
        process = None
        
        status_var.set("Server Status: STOPPED")
        start_btn.config(state=tk.NORMAL)
        stop_btn.config(state=tk.DISABLED)
        
        root.title("Server Manager - Stopped")
        start_btn.focus_set()

def on_closing():
    stop_server()
    root.destroy()

root = tk.Tk()
root.title("Server Manager - Stopped")
root.geometry("400x250")
# Ensure the server turns off if you just close the app window!
root.protocol("WM_DELETE_WINDOW", on_closing)

# Frame for padding
frame = tk.Frame(root, padx=20, pady=20)
frame.pack(expand=True, fill=tk.BOTH)

status_var = tk.StringVar(value="Server Status: STOPPED")
status_label = tk.Label(frame, textvariable=status_var, font=("Arial", 16, "bold"))
status_label.pack(pady=(0, 20))

start_btn = tk.Button(frame, text="Start Server", font=("Arial", 14), command=start_server)
start_btn.pack(fill=tk.X, pady=10)

stop_btn = tk.Button(frame, text="Stop Server", font=("Arial", 14), command=stop_server, state=tk.DISABLED)
stop_btn.pack(fill=tk.X, pady=10)

# Set initial focus for screen reader (Tab key starts here)
start_btn.focus_set()

root.mainloop()
