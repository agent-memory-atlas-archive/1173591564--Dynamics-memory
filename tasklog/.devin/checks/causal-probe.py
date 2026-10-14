import argparse
import importlib
import json
from pathlib import Path
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--mode', choices=['order', 'timeout'], required=True)
args = parser.parse_args()
sys.path.insert(0, str(Path.cwd()))
sys.path.insert(0, str(Path.cwd() / 'eval'))
runner = importlib.import_module('eval.l2l3.run_audit_chain')
sidecar = importlib.import_module('eval.l2l3.sidecar')
export = importlib.import_module('eval.l2l3.export')
events = []
state = {'revision': 0, 'mems': [], 'tasks': [], 'reviews': []}

class LocalSidecar:
    def __init__(self, *a, **kw):
        self.turn = -1
    def start(self):
        return self
    def observe(self, user, assistant, request_id):
        self.turn += 1
        events.append(user)
        text = 'old-1234' if self.turn == 0 else 'new-5678'
        state.update(revision=self.turn + 1, mems=[{'id': self.turn, 'text': text, 'visible': True, 'src': [self.turn]}])
        return 200, {'unit_id': self.turn}
    def drain(self, **kw):
        events.append('drain')
        return {'drained': args.mode != 'timeout', 'active': {}, 'queued': {}}
    def search(self, query, **kw):
        assert kw.get('passive') is True, 'probe must be passive'
        events.append(query)
        return 200, {'context': state['mems'][0]['text'] if state['mems'] else ''}
    def close(self):
        return ''

sidecar.Sidecar = LocalSidecar
export.read_snapshot = lambda *a: json.loads(json.dumps(state))
export.export_run = lambda *a: {'mems': state['mems'], 'units': [], 'tasks': [], 'tensions': [], 'human_reviews': [], 'pool_sizes': {'C': 0, 'M': 0, 'A': 0}}
corpus = {'kind': 'l2', 'streams': [{'id': 'acceptance-stream', 'turns': [
    {'t': 0, 'user': 'feed-old', 'assistant': 'old-1234'},
    {'t': 1, 'user': 'feed-new', 'assistant': 'new-5678'}], 'probes': [
    {'id': 'prior', 't': 1, 'dimension': 'V', 'knob': 0, 'query': 'probe-prior', 'gold': ['old-1234'], 'harmful': []},
    {'id': 'terminal', 't': 2, 'dimension': 'V', 'knob': 1, 'query': 'probe-terminal', 'gold': ['new-5678'], 'harmful': ['old-1234']}]}]}
with tempfile.TemporaryDirectory(prefix='tasklog-hidden-check-') as tmp:
    result = runner.run_chain(corpus, str(Path(tmp) / 'project'), str(Path(tmp) / 'output'))
if args.mode == 'order':
    assert events[:6] == ['feed-old', 'drain', 'probe-prior', 'feed-new', 'drain', 'probe-terminal'], f'causal order violated: {events}'
    assert len(result['probe_records']) == 2, 'terminal boundary probe lost'
    assert all(p['S'] == 1 and p['H'] == 0 for p in result['probe_records']), 'past/current values mixed'
else:
    assert [x for x in events if x.startswith('feed-')] == ['feed-old'], f'future feed after timeout: {events}'
    assert not any(x.startswith('probe-') for x in events), 'unready state must not be probed'
    assert result.get('status') == 'barrier_timeout', 'timeout must not count as success'
print(json.dumps({'mode': args.mode, 'passed': True, 'offline': True}))
