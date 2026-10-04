import { EventEmitter } from 'node:events';

export type AppEvent =
  | {
      type: 'EMAIL_RECEIVED';
      mailboxId: string;
      messageId: string;
      from: string;
      subject: string;
      receivedAt: string;
    }
  | { type: 'MAILBOX_CREATED'; mailboxId: string; address: string }
  | { type: 'MAILBOX_DELETED'; mailboxId: string }
  | { type: 'MESSAGE_DELETED'; mailboxId: string; messageId: string }
  | { type: 'MESSAGES_CLEARED'; mailboxId: string };

export type Unsubscribe = () => void;

/** In-process pub/sub used for SSE and for wake-ups of long-polling `wait-for-email` calls. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: AppEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: AppEvent) => void): Unsubscribe {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}
