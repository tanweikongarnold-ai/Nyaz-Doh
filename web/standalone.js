// Single-file solo build: instead of connecting to a game server over a WebSocket,
// the page runs the same server code itself. app.js doesn't know the difference.
import { RoomManager } from '../server/rooms.js';

const manager = new RoomManager();

class LocalSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    // What the server sees as "the client's socket".
    this.peer = {
      readyState: 1,
      send: (data) => setTimeout(() => {
        if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data }));
      }, 0),
      close: (code) => this.close(code),
    };
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }, 0);
  }

  send(data) {
    if (this.readyState === 1) manager.handle(this.peer, String(data));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.peer.readyState = 3;
    manager.socketClosed(this.peer);
    this.dispatchEvent(new CloseEvent('close', { code }));
  }
}

window.WebSocket = LocalSocket;
window.GAME_OFFLINE = true;
document.body.classList.add('offline');
