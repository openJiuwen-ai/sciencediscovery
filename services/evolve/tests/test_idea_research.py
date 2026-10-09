
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from sciencediscovery_evolve.vendor.idea_tree.research import IdeaTreeEngine, ResearchStore, node, now, parse_json
from sciencediscovery_evolve.vendor.idea_tree.research_service import Settings
from sciencediscovery_evolve.vendor.idea_tree.templates import snapshot


class ResearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ResearchStore(Path(self.temp.name))
        self.state = dict(id='research-test', projectId='p', sessionId='s', objective='No cobalt. Compare catalyst directions.', materials='Supplied material', modelId='m', settings=Settings(templateId='water-treatment-materials/v1', candidatesPerRound=1, maxDepth=6).model_dump(), template=snapshot('water-treatment-materials/v1'),
                          status='paused', phase='ideate', round=0, batch=[], batchCompleted=0, tokens=0, usageKnown=True,
                          reason=None, currentNodeId=None, createdAt=now(), updatedAt=now(), nodes=[node('ROOT', None, 'Goal', 'direction', 0)])
        self.calls = []

    async def model(self, role, payload):
        self.calls.append((role, payload))
        if role == 'ideate':
            r = payload['round']
            value = dict(candidates=[dict(parentId=payload['selectedParentIds'][0], direction=f'Direction {r}' if r < 3 else 'Direction 1', hypothesis=f'Candidate {r}: addresses prior leaching')], reason='A distinct improvement remains')
        elif role in ['activity', 'stability', 'sustainability']:
            self.assertNotIn('assessments', payload)
            value = dict(text='Independent assessment', score={'activity': 8, 'stability': 6, 'sustainability': 4}[role])
        elif role == 'aggregate':
            value = dict(text='aggregate output', strengths=[], failureModes=[], uncertainties=[], evidenceGaps=[], recommendedNextMoves=[], constraintFlags=[], confidence=.5)
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
        self.assertTrue(any(candidate['childrenIds'] for candidate in candidates))
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

    async def test_candidates_execute_before_max_depth_and_can_branch(self):
        self.state['settings']['maxDepth'] = 6
        async def model(role, payload):
            if role == 'ideate':
                return json.dumps(dict(candidates=[dict(parentId=payload['selectedParentIds'][0], direction='Fe catalysts', refinements=[], hypothesis=f'Improvement {payload["round"]}')], reason='Refine from prior feedback')), 100
            return await self.model(role, payload)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'completed')
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertTrue(all(n['depth'] <= 6 for n in candidates))
        self.assertTrue(any(n['depth'] < 6 for n in candidates))
        self.assertTrue(any(n['childrenIds'] for n in candidates))
        directions = [n for n in self.state['nodes'] if n['kind'] == 'direction']
        self.assertTrue(all(n['score'] is None and not n['stages'] for n in directions))
        self.assertTrue(all(n['insight'] for n in directions))

    async def test_capped_batch_finishes_without_competing_reservations(self):
        self.state['settings'].update(maxRounds=1, candidatesPerRound=2, maxDepth=1,
                                      candidateConcurrency=2, maxTokens=60000)
        calls = 0
        async def model(role, payload):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0)
            if role == 'ideate':
                return json.dumps(dict(candidates=[dict(parentId='ROOT', hypothesis=h)
                                                  for h in ['Candidate A', 'Candidate B']], reason='Compare')), 100
            return await self.model(role, payload)
        engine = IdeaTreeEngine(self.state, self.store, {}, model)
        await engine.run()
        self.assertEqual(self.state['status'], 'completed')
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertEqual(len(candidates), 2)
        self.assertTrue(all(n['cycleComplete'] for n in candidates))
        self.assertEqual(self.state['tokens'], calls * 100)
        self.assertEqual(engine.reserved, 0)

    async def test_concurrent_usage_settlement_releases_failed_requests(self):
        async def model(role, payload):
            await asyncio.sleep(0)
            if payload['usage'] == 'error':
                raise RuntimeError('provider unavailable')
            return '{"text":"design"}', payload['usage']
        engine = IdeaTreeEngine(self.state, self.store, {}, model)
        results = await asyncio.gather(*(engine._ask('design', {'usage': usage})
                                        for usage in [100, 200, None, 'error']), return_exceptions=True)
        self.assertIsInstance(results[-1], RuntimeError)
        self.assertEqual(self.state['tokens'], 300)
        self.assertFalse(self.state['usageKnown'])
        self.assertEqual(engine.reserved, 0)

    async def test_shallow_candidate_runs_and_pending_parent_is_rejected(self):
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        shallow = node('1', 'ROOT', 'Shallow', 'candidate', 1)
        self.state['nodes'].append(shallow)
        await engine.evaluate(shallow)
        pending = node('2', 'ROOT', 'Pending', 'candidate', 1)
        self.state['nodes'].append(pending)
        with self.assertRaisesRegex(ValueError, 'only after evaluation'):
            engine.proposal_path(dict(parentId='2', direction='Follow-up', hypothesis='Child'))
        self.assertTrue(shallow['insightRecords'])

    def test_completed_candidate_can_create_a_deeper_direction(self):
        self.state['settings']['maxDepth'] = 3
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        parent = node('1', 'ROOT', 'Initial hypothesis', 'candidate', 1)
        parent.update(status='done', score=5)
        self.state['nodes'][0]['childrenIds'].append('1')
        self.state['nodes'].append(parent)
        selected_parent, path = engine.proposal_path(dict(parentId='1', direction='Mechanism follow-up', refinements=[], hypothesis='Child hypothesis'))
        self.assertEqual(selected_parent['id'], '1')
        self.assertEqual(path, ['Mechanism follow-up'])

    async def test_selector_prunes_weak_direction_and_proposals_record_lineage(self):
        root = self.state['nodes'][0]
        weak = node('1', 'ROOT', 'Weak direction', 'direction', 1)
        strong = node('2', 'ROOT', 'Strong direction', 'direction', 1)
        root['childrenIds'] = ['1', '2']
        self.state['nodes'].extend([weak, strong])
        for index, parent, score in [('3', weak, 2), ('4', weak, 3), ('5', weak, 2), ('6', strong, 9)]:
            candidate = node(index, parent['id'], index, 'candidate', 2)
            candidate.update(status='done', score=score)
            parent['childrenIds'].append(index)
            self.state['nodes'].append(candidate)
        self.state['settings'].update(pruneMinAssessments=3, pruneScoreGap=2, maxActiveDirections=2)
        selected = IdeaTreeEngine(self.state, self.store, {}, self.model).select_directions()
        self.assertEqual(weak['searchStatus'], 'pruned')
        self.assertIn(strong, selected)

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

    async def test_a_parent_outside_the_selection_gets_one_correction(self):
        # Observed with Kimi: round 2 proposed under a direction that was not selected, and the
        # research stopped without the model being told, as a malformed answer would have been.
        self.state['settings']['maxRounds'] = 1
        asked = []

        async def model(role, payload):
            if role == 'ideate':
                asked.append(payload)
                parent = 'NOT-SELECTED' if len(asked) == 1 else payload['selectedParentIds'][0]
                return json.dumps(dict(candidates=[dict(parentId=parent, direction='D', hypothesis='H', rationale='R')], reason='r')), 10
            return await self.model(role, payload)
        self.state['nodes'].append({**node('NOT-SELECTED', 'ROOT', 'Other', 'direction', 1), 'searchStatus': 'pruned'})
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(len(asked), 2)
        self.assertIn('not selected', asked[1]['correction'])
        self.assertNotEqual(self.state['status'], 'interrupted')

    async def test_propagation_resume_skips_saved_parent(self):
        self.state['settings']['maxRounds'] = 1
        fail = True
        async def model(role, payload):
            if fail and role == 'propagate' and payload['parent'] == 'Goal':
                raise RuntimeError('temporary outage')
            return await self.model(role, payload)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'interrupted')
        self.assertEqual(sum(r == 'propagate' for r, _ in self.calls), 0)
        fail = False
        resumed = self.store.read('p', 's', 'research-test')
        await IdeaTreeEngine(resumed, self.store, {}, model).run()
        self.assertEqual(resumed['status'], 'completed')
        self.assertEqual(sum(r == 'design' for r, _ in self.calls), 1)
        self.assertEqual(sum(r == 'propagate' for r, _ in self.calls), 1)

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
        async def ask(engine, role, payload, check=None):
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

    async def test_batch_candidates_run_concurrently_before_ordered_insight_propagation(self):
        self.state['settings'].update(maxRounds=1, candidatesPerRound=2, maxDepth=1, candidateConcurrency=2)
        designs_started, release = asyncio.Event(), asyncio.Event()
        active_designs = 0
        async def model(role, payload):
            nonlocal active_designs
            if role == 'ideate':
                return json.dumps(dict(candidates=[
                    dict(parentId='ROOT', hypothesis='Candidate A'),
                    dict(parentId='ROOT', hypothesis='Candidate B'),
                ], reason='Compare independent paths')), 100
            if role == 'design':
                active_designs += 1
                if active_designs == 2:
                    designs_started.set()
                await release.wait()
            return await self.model(role, payload)
        task = asyncio.create_task(IdeaTreeEngine(self.state, self.store, {}, model).run())
        await asyncio.wait_for(designs_started.wait(), timeout=2)
        self.assertEqual(len([role for role, _ in self.calls if role == 'propagate']), 0)
        release.set()
        await task
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertEqual([n['hypothesis'] for n in candidates], ['Candidate A', 'Candidate B'])
        self.assertTrue(all(n['cycleComplete'] and n['propagatedTo'] for n in candidates))

    async def test_failed_stage_is_visible_and_persisted(self):
        async def broken(role, payload):
            raise RuntimeError('provider unavailable')
        engine = IdeaTreeEngine(self.state, self.store, {}, broken)
        await engine.run()
        saved = self.store.read('p', 's', 'research-test')
        self.assertEqual(saved['status'], 'interrupted')
        self.assertEqual(saved['activities'][0]['status'], 'failed')
        self.assertEqual(saved['activities'][0]['error'], 'provider unavailable')


def test_transport_leaves_temperature_to_the_provider(monkeypatch):
    # Kimi answers 400 "invalid temperature: only 1 is allowed" to any other value.
    sent = []

    class Reply:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, *_):
            return json.dumps(dict(choices=[dict(message=dict(content='{}'))], usage=dict(total_tokens=7))).encode()

    def urlopen(request, timeout):
        sent.append(json.loads(request.data))
        return Reply()

    monkeypatch.setattr('urllib.request.urlopen', urlopen)
    with tempfile.TemporaryDirectory() as root:
        engine = IdeaTreeEngine(dict(id='r'), ResearchStore(Path(root)), dict(url='http://model.test/v1/chat/completions', token='t'))
        assert engine.transport('system', dict(a=1), 100) == ('{}', 7)
    assert 'temperature' not in sent[0]
    assert sent[0]['max_tokens'] == 100


def test_a_fenced_json_answer_is_read_as_json():
    # Kimi answers the ideation prompt with ```json ... ```.
    assert parse_json('```json\n{"candidates": []}\n```') == {'candidates': []}
    assert parse_json('  ```\n{"a": 1}\n```  ') == {'a': 1}
    assert parse_json('{"a": 1}') == {'a': 1}
    with pytest.raises(ValueError):
        parse_json('```python\n{"a": 1}\n```')
    with pytest.raises(ValueError):
        parse_json('Here it is: {"a": 1}')
