const { app, BrowserWindow, globalShortcut } = require('electron')
const path = require('node:path')

const createWindow = () => {
    const win = new BrowserWindow({
        width: 600,
        height: 400,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    })

    win.loadFile('index.html')

    // Optional: Global shortcut for push to talk, mapped to F12 or something user friendly
    // For MVP, we'll keep the button in UI so Screen Reader users can tab to it and hold it easily using the Spacebar.
    // Accessibility is often best served by native UI interactions first.
    
    // Uncomment for developer tools if needed
    // win.webContents.openDevTools()
}

app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})
