import { Router } from './router';

interface ServerConfig {
  port: number;
}

export class Server {
  private router: Router;

  constructor(private config: ServerConfig) {
    this.router = new Router();
  }

  async start(): Promise<void> {
    this.router.handleRequest('/');
  }
}

export function createServer(config: ServerConfig): Server {
  return new Server(config);
}
