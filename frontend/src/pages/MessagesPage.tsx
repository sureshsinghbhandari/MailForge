import { MessageList } from '../components/MessageList';
import { PageHeader } from '../components/ui';

export function MessagesPage() {
  return (
    <div>
      <PageHeader title="Messages" subtitle="Search across every mailbox." />
      <MessageList />
    </div>
  );
}
