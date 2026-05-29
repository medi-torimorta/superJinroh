declare module 'ws' {
  import type { IncomingMessage, Server as HttpServer } from 'node:http';

  export class WebSocket {
    static readonly OPEN: number;
    readonly OPEN: number;
    readyState: number;
    send(data: string): void;
    on(event: 'close', listener: () => void): this;
  }

  export interface WebSocketServerOptions {
    server: HttpServer;
    path?: string;
  }

  export class WebSocketServer {
    constructor(options: WebSocketServerOptions);
    close(): void;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void | Promise<void>): this;
  }
}
