import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from sciencediscovery_evolve.vendor.idea_tree.research import IdeaTreeEngine, ResearchStore, node, now
from sciencediscovery_evolve.vendor.idea_tree.research_service import Settings


class ResearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ResearchStore(Path(self.temp.name))
        self.state = dict(id='research-test', projectId='p', sessionId='s', objective='No cobalt. Compare catalyst directions.', materials='Supplied material', modelId='m', settings=Settings(candidatesPerRound=1, maxDepth=2).model_dump(),
                          status='paused', phase='ideate', round=0, batch=[], batchCompleted=0, tokens=0, usageKnown=True,
                          reason=None, currentNodeId=None, createdAt=now(), updatedAt=now(), nodes=[node('ROOT', None, 'Goal', 'direction', 0)])
        self.calls = []

    async def model(self, role, payload):
        self.calls.append((role, payload))
        if role == 'ideate':
            r = payload['round']
            value = dict(candidates=[dict(direction=f'Direction {r}' if r < 3 else 'Direction 1', hypothesis=f'Candidate {r}: addresses prior leaching')], reason='A distinct improvement remains')
        elif role in ['activity', 'stability', 'sustainability']:
            self.assertNotIn('assessments', payload)
            value = dict(text='Independent assessment', score={'activity': 8, 'stability': 6, 'sustainability': 4}[role])
        else:
            value = dict(text=f'{role} output')
        return json.dumps(value), 100

    async def test_three_rounds_and_weighted_score(self):
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        await engine.run()
        self.assertEqual(self.state['status'], 'completed')
        self.assertEqual(self.state['round'], 3)
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertEqual(len(candidates), 3)
        self.assertTrue(all(n['score'] == 6.1 and n['cycleComplete'] for n in candidates))
        self.assertEqual(candidates[0]['parentId'], candidates[2]['parentId'])
        self.assertNotEqual(candidates[0]['parentId'], candidates[1]['parentId'])
        self.assertEqual(self.store.read('p', 's', 'research-test')['status'], 'completed')

    async def test_interrupted_assessment_reuses_design_and_successful_assessments(self):
        fail = True
        async def model(role, payload):
            if role == 'stability' and fail:
                raise RuntimeError('Model HTTP 429: budget exceeded')
            return await self.model(role, payload)
        engine = IdeaTreeEngine(self.state, self.store, {}, model)
        await engine.run()
        self.assertEqual(self.state['status'], 'interrupted')
        candidate = next(n for n in self.state['nodes'] if n['kind'] == 'candidate')
        self.assertIn('design', candidate['stages'])
        self.assertIn('activity', candidate['stages'])
        fail = False
        prior = len([c for c in self.calls if c[0] == 'design'])
        self.state['settings']['maxRounds'] = 1
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'completed')
        self.assertEqual(len([c for c in self.calls if c[0] == 'design']), prior)

    async def test_pause_does_not_commit_late_result(self):
        gate = asyncio.Event()
        entered = asyncio.Event()
        async def model(role, payload):
            entered.set()
            await gate.wait()
            return await self.model(role, payload)
        engine = IdeaTreeEngine(self.state, self.store, {}, model)
        task = asyncio.create_task(engine.run())
        await entered.wait()
        engine.stop_action = 'pause'
        gate.set()
        await task
        self.assertEqual(self.state['status'], 'paused')
        self.assertEqual(len(self.state['nodes']), 1)
        self.assertEqual(self.state['tokens'], 100)

    async def test_token_budget_and_missing_usage(self):
        self.state['settings']['maxTokens'] = 1
        await IdeaTreeEngine(self.state, self.store, {}, self.model).run()
        self.assertEqual(self.state['status'], 'paused')
        self.assertEqual(self.calls, [])
        self.state['settings']['maxTokens'] = 100000
        async def unknown(role, payload):
            raw, _ = await self.model(role, payload)
            return raw, None
        await IdeaTreeEngine(self.state, self.store, {}, unknown).run()
        self.assertEqual(self.state['status'], 'interrupted')
        self.assertIn('did not report', self.state['reason'])

    async def test_only_execution_depth_leaves_run_and_improvements_are_siblings(self):
        self.state['settings']['maxDepth'] = 4
        async def model(role, payload):
            if role == 'ideate':
                return json.dumps(dict(candidates=[dict(direction='Fe catalysts', refinements=['Iron oxides', 'Recyclable support'], hypothesis=f'Improvement {payload["round"]}')], reason='Refine from prior feedback')), 100
            return await self.model(role, payload)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'completed')
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertEqual([n['depth'] for n in candidates], [4, 4, 4])
        self.assertEqual(len({n['parentId'] for n in candidates}), 1)
        self.assertTrue(all(not n['childrenIds'] for n in candidates))
        directions = [n for n in self.state['nodes'] if n['kind'] == 'direction']
        self.assertTrue(all(n['score'] is None and not n['stages'] for n in directions))
        self.assertTrue(all(n['insight'] for n in directions))

    async def test_shallow_candidate_and_scored_parent_are_rejected(self):
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        shallow = node('1', 'ROOT', 'Shallow', 'candidate', 1)
        self.state['nodes'].append(shallow)
        with self.assertRaisesRegex(ValueError, 'Only candidate leaves'):
            await engine.evaluate(shallow)
        with self.assertRaisesRegex(ValueError, 'Parent must be a direction'):
            engine.proposal_path(dict(parentId='1', hypothesis='Child'))
        self.assertEqual(self.calls, [])

    async def test_invalid_response_corrected_once_without_partial_tree(self):
        async def invalid(role, payload):
            self.calls.append((role, payload))
            return 'not json', 5
        await IdeaTreeEngine(self.state, self.store, {}, invalid).run()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.state['status'], 'interrupted')
        self.assertEqual(self.state['tokens'], 10)
        self.assertEqual(len(self.state['nodes']), 1)

    async def test_invalid_parent_does_not_save_partial_batch(self):
        self.state['settings']['candidatesPerRound'] = 2
        async def invalid(role, payload):
            return json.dumps(dict(candidates=[dict(direction='D', hypothesis='Valid'), dict(parentId='absent', hypothesis='Invalid')], reason='Two proposals')), 10
        await IdeaTreeEngine(self.state, self.store, {}, invalid).run()
        self.assertEqual(self.state['status'], 'interrupted')
        self.assertEqual(len(self.store.read('p', 's', 'research-test')['nodes']), 1)

    async def test_propagation_resume_skips_saved_parent(self):
        self.state['settings']['maxRounds'] = 1
        fail = True
        async def model(role, payload):
            if fail and role == 'propagate' and payload['parent'] == 'Goal':
                raise RuntimeError('temporary outage')
            return await self.model(role, payload)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'interrupted')
        self.assertEqual(sum(r == 'propagate' for r, _ in self.calls), 1)
        fail = False
        resumed = self.store.read('p', 's', 'research-test')
        await IdeaTreeEngine(resumed, self.store, {}, model).run()
        self.assertEqual(resumed['status'], 'completed')
        self.assertEqual(sum(r == 'design' for r, _ in self.calls), 1)
        self.assertEqual(sum(r == 'propagate' for r, _ in self.calls), 2)

    async def test_total_candidate_limit_and_depth_one(self):
        self.state['settings'].update(maxDepth=1, maxNodes=2, maxSearchRounds=1)
        await IdeaTreeEngine(self.state, self.store, {}, self.model).run()
        self.assertEqual(self.state['status'], 'completed')
        self.assertEqual(self.state['round'], 1)
        self.assertEqual(self.state['nodes'][1]['depth'], 1)
        self.assertEqual(self.state['nodes'][1]['score'], 6.1)

    async def test_service_pause_end_and_restart_are_manual(self):
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        from fastapi import HTTPException
        entered, release = asyncio.Event(), asyncio.Event()
        async def ask(engine, role, payload):
            entered.set()
            await release.wait()
            engine.check_stop()
            return dict(candidates=[], reason='Done')
        with patch.object(service, '_store', self.store), patch.object(IdeaTreeEngine, 'ask', ask):
            c = service.Command(projectId='p', sessionId='s', operation='create', objective='Goal', llm=dict(url='http://localhost', token='local'))
            created = await service.command(c)
            identifier = created['research']['id']
            await entered.wait()
            with self.assertRaises(HTTPException) as conflict:
                await service.command(c)
            self.assertEqual(conflict.exception.status_code, 409)
            task = service._running[identifier][1]
            paused = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='pause'))
            self.assertEqual(paused['research']['status'], 'pausing')
            release.set()
            await task
            self.assertEqual(service.state_for('p', 's', identifier)['status'], 'paused')
            # A persisted running flag after a process restart is never an auto-resume instruction.
            saved = self.store.read('p', 's', identifier)
            saved['status'] = 'running'
            self.store.save(saved)
            self.assertEqual(service.state_for('p', 's', identifier)['status'], 'interrupted')
            ended = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='end'))
            self.assertEqual(ended['research']['status'], 'ended')
            self.assertNotIn(identifier, service._running)

    async def test_parallel_assessments_publish_independent_progress(self):
        started = asyncio.Event()
        release = asyncio.Event()
        async def model(role, payload):
            if role in ['activity', 'stability', 'sustainability']:
                running = [a for a in self.state['activities'] if a['status'] == 'running']
                if len(running) == 3:
                    started.set()
                await release.wait()
            return await self.model(role, payload)
        engine = IdeaTreeEngine(self.state, self.store, {}, model)
        self.state['settings']['maxDepth'] = 1
        candidate = node('1', 'ROOT', 'Candidate', 'candidate', 1)
        self.state['nodes'].append(candidate)
        self.state['nodes'][0]['childrenIds'].append('1')
        queue = asyncio.Queue(maxsize=1)
        self.store.listeners['research-test'] = {queue}
        task = asyncio.create_task(engine.evaluate(candidate))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            saved = self.store.read('p', 's', 'research-test')
            running = [a for a in saved['activities'] if a['status'] == 'running']
            self.assertEqual({a['role'] for a in running}, {'activity', 'stability', 'sustainability'})
            self.assertEqual({a['nodeId'] for a in running}, {'1'})
            self.assertFalse(queue.empty())
        finally:
            release.set()
            await task
        self.assertTrue(all(a['status'] == 'completed' and a['finishedAt'] for a in self.state['activities']))

    async def test_failed_stage_is_visible_and_persisted(self):
        async def broken(role, payload):
            raise RuntimeError('provider unavailable')
        engine = IdeaTreeEngine(self.state, self.store, {}, broken)
        await engine.run()
        saved = self.store.read('p', 's', 'research-test')
        self.assertEqual(saved['status'], 'interrupted')
        self.assertEqual(saved['activities'][0]['status'], 'failed')
        self.assertEqual(saved['activities'][0]['error'], 'provider unavailable')
