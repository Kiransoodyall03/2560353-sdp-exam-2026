import { Panel } from '../components/ui';

export function ReplayPage() {
  return (
    <div className="page">
      <h1>Replay</h1>
      <Panel>
        <p className="muted">
          Replay of stored raw messages through the same reducers is planned for a later phase. Every message is already
          persisted to <code>raw_messages</code> before dispatch, so history recorded now will be replayable.
        </p>
      </Panel>
    </div>
  );
}
