
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
import asyncio
import io
import json
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
from pathlib import Path

from sciencediscovery_evolve.vendor.idea_tree.research import IdeaTreeEngine, Interrupted, ResearchStore, node, now, parse_json
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

    async def test_empty_or_truncated_stage_preserves_usage_without_format_correction(self):
        for raw in (None, '', '  '):
            calls = []
            async def truncated(role, payload):
                calls.append(payload)
                return raw, 14
            self.state['tokens'] = 0
            engine = IdeaTreeEngine(self.state, self.store, {}, truncated)
            with self.assertRaisesRegex(ValueError, 'design: empty or truncated model output'):
                await engine.ask('design', {})
            self.assertEqual(len(calls), 1)
            self.assertEqual(self.state['tokens'], 14)
            self.assertEqual(engine.reserved, 0)
            persisted = self.store.read('p', 's', 'research-test')
            self.assertEqual(persisted['tokens'], 14)
            self.assertEqual(persisted['activities'][-1]['status'], 'failed')
            self.assertIn('empty or truncated', persisted['activities'][-1]['error'])

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

    def test_initial_exploit_requires_explore_even_with_fabricated_lineage(self):
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        with self.assertRaisesRegex(ValueError, 'Use explorationType=explore'):
            engine.validate_proposal(dict(parentId='ROOT', direction='New direction', hypothesis='H',
                                          explorationType='exploit', basedOnCandidateIds=[],
                                          addressesInsightIds=[]), ['ROOT'])
        with self.assertRaisesRegex(ValueError, 'Use explorationType=explore'):
            engine.validate_proposal(dict(parentId='ROOT', direction='New direction', hypothesis='H',
                                          explorationType='exploit', basedOnCandidateIds=['ROOT'],
                                          addressesInsightIds=['ROOT']), ['ROOT'])

    async def test_initial_ideation_corrects_exploit_to_explicit_explore(self):
        ideate_calls = []

        async def model(role, payload):
            raw, tokens = await self.model(role, payload)
            if role == 'ideate':
                ideate_calls.append(payload)
                result = json.loads(raw)
                result['candidates'][0]['rationale'] = 'Test a distinct mechanism'
                result['candidates'][0]['explorationType'] = 'explore' if 'correction' in payload else 'exploit'
                return json.dumps(result), tokens
            return raw, tokens

        self.state['settings']['maxSearchRounds'] = 1
        engine = IdeaTreeEngine(self.state, self.store, {}, model)
        self.assertIn('"explorationType":"explore"', engine.role_prompt('ideate'))
        await engine.run()
        self.assertEqual(self.state['status'], 'completed', self.state['reason'])
        self.assertEqual(len(ideate_calls), 2)
        self.assertIn('Use explorationType=explore', ideate_calls[1]['correction'])
        candidate = next(n for n in self.state['nodes'] if n['kind'] == 'candidate')
        self.assertEqual(candidate['explorationType'], 'explore')
        self.assertNotIn('Every proposal must use explorationType=explore', engine.role_prompt('ideate'))
        proposal = dict(parentId='ROOT', direction='Follow-up', hypothesis='New H',
                        explorationType='exploit', basedOnCandidateIds=[candidate['id']],
                        addressesInsightIds=[candidate['insightRecords'][0]['id']],
                        targetedWeakness='Weakness', expectedImprovement='Improvement', newRisk='Risk')
        engine.validate_proposal(proposal, ['ROOT'])
        with self.assertRaisesRegex(ValueError, 'unknown candidate or insight'):
            engine.validate_proposal({**proposal, 'addressesInsightIds': ['unknown']}, ['ROOT'])

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
                # What transport() raises once its retry budget is exhausted
                # (issue #1232): the stage fails, the run is interrupted, and
                # the completed stages are kept for the resume.
                raise RuntimeError('Model HTTP 429: retry budget exhausted after 2 attempts')
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

    async def test_run_continues_same_stage_after_transient_429(self):
        # Issue #1232: one 429 on the first model call must not interrupt the
        # research; the same stage continues once the retry succeeds.
        attempts = []
        sleeps = []

        class Reply:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, *_):
                return self.body

        def urlopen(request, timeout):
            body = json.loads(request.data)
            system = body['messages'][0]['content']
            attempts.append(json.loads(body['messages'][1]['content']))
            if len(attempts) == 1:
                raise urllib.error.HTTPError(request.full_url, 429, 'Too Many Requests', {'Retry-After': '1'},
                                             io.BytesIO(b'{"error":{"type":"rate_limit_exceeded","message":"Too many requests; retry shortly"}}'))
            if '"candidates"' in system:
                payload = json.loads(body['messages'][1]['content'])
                value = dict(candidates=[dict(parentId=payload['selectedParentIds'][0], direction=f"Direction {payload['round']}", hypothesis=f"Candidate {payload['round']}: addresses prior leaching")], reason='A distinct improvement remains')
            elif '"score":1.0' in system:
                value = dict(text='Independent assessment', score=8)
            elif '"strengths"' in system:
                value = dict(text='aggregate output', strengths=[], failureModes=[], uncertainties=[], evidenceGaps=[], recommendedNextMoves=[], constraintFlags=[], confidence=.5)
            else:
                value = dict(text='design output')
            reply = Reply()
            reply.body = json.dumps(dict(choices=[dict(message=dict(content=json.dumps(value)))], usage=dict(total_tokens=100))).encode()
            return reply

        monkeypatch = unittest.mock.patch('urllib.request.urlopen', urlopen)
        sleep_patch = unittest.mock.patch.object(time, 'sleep', sleeps.append)
        with monkeypatch, sleep_patch:
            await IdeaTreeEngine(self.state, self.store, dict(url='http://model.test/v1/chat/completions', token='t')).run()
        self.assertEqual(self.state['status'], 'completed', self.state['reason'])
        # The first round's ideation was attempted twice (429, then success);
        # later rounds were attempted once each.
        ideations = [payload for payload in attempts if 'selectedParentIds' in payload]
        self.assertEqual([payload['round'] for payload in ideations], [1, 1, 2, 3])
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertTrue(candidates and all(n['status'] == 'done' for n in candidates))
        # One bounded wait, honoring the provider's Retry-After: 1.
        self.assertAlmostEqual(sum(sleeps), 1.0)

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
        self.assertEqual(self.state['status'], 'paused')
        self.assertIn('budget', self.state['reason'])
        self.assertFalse(self.state['usageKnown'])
        self.assertGreater(self.state['unreportedBudgetEstimate'], 0)

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

    async def test_unknown_usage_preserves_scores_under_a_token_budget(self):
        self.state['settings'].update(maxRounds=1, maxTokens=600000)
        async def unknown_model(role, payload):
            result, _usage = await self.model(role, payload)
            return result, None
        await IdeaTreeEngine(self.state, self.store, {}, unknown_model).run()
        self.assertEqual(self.state['status'], 'completed')
        self.assertFalse(self.state['usageKnown'])
        self.assertEqual(self.state['tokens'], 0)  # No measured counts; explicitly partial.
        self.assertGreater(self.state['unreportedBudgetEstimate'], 0)
        candidates = [n for n in self.state['nodes'] if n['kind'] == 'candidate']
        self.assertTrue(candidates)
        self.assertTrue(all(n['score'] == 6.1 and n['cycleComplete'] for n in candidates))

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

    async def test_failed_unknown_call_releases_admission_budget_and_persists_uncertainty(self):
        calls = []
        async def call(role, payload):
            calls.append(role)
            if len(calls) == 1:
                raise RuntimeError('synthetic failure before I/O')
            return '{"text":"valid design"}', 100
        engine = IdeaTreeEngine(self.state, self.store, {}, call)
        with self.assertRaisesRegex(RuntimeError, 'before I/O'):
            await engine.ask('design', {})
        self.assertEqual(engine.reserved, 0)
        self.assertEqual(self.state.get('unreportedBudgetEstimate', 0), 0)
        self.assertEqual(self.state['tokens'], 0)
        self.assertFalse(self.state['usageKnown'])  # Failure is not proof of free provider usage.
        persisted = self.store.read('p', 's', 'research-test')
        self.assertEqual(persisted.get('unreportedBudgetEstimate', 0), 0)
        self.assertFalse(persisted['usageKnown'])
        self.assertEqual(persisted['activities'][-1]['status'], 'failed')
        # Just enough for one stage; a stale failed-call reserve would block it.
        self.state['settings']['maxTokens'] = len((engine.role_prompt('design') + '\nReturn JSON only, matching: {"text":"..."}' + '{}').encode()) + 32768 + 256  # the reservation constant, not a cap
        self.assertEqual(await engine.ask('design', {}), {'text': 'valid design'})
        self.assertEqual(len(calls), 2)
        self.assertEqual(engine.reserved, 0)
        self.assertEqual(self.state['tokens'], 100)

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
        assert engine.transport('system', dict(a=1)) == ('{}', 7)
    assert 'temperature' not in sent[0]
    assert 'max_tokens' not in sent[0], 'the per-call cap is gone: the request carries no max_tokens'


def rate_limit_error(url, after='1', error_type='rate_limit_exceeded'):
    return urllib.error.HTTPError(url, 429, 'Too Many Requests', {'Retry-After': after},
                                  io.BytesIO(json.dumps(dict(error=dict(type=error_type, message='Too many requests; retry shortly'))).encode()))


class SuccessReply:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, *_):
        return json.dumps(dict(choices=[dict(message=dict(content='{}'))], usage=dict(total_tokens=7))).encode()


def transport_with_faults(monkeypatch, faults):
    """A transport whose urlopen fails per `faults`, then succeeds; sleeps are recorded, not waited."""
    attempts = []
    sleeps = []

    def urlopen(request, timeout):
        attempts.append(1)
        if len(attempts) <= len(faults):
            raise faults[len(attempts) - 1](request.full_url)
        return SuccessReply()

    monkeypatch.setattr('urllib.request.urlopen', urlopen)
    monkeypatch.setattr(time, 'sleep', sleeps.append)
    with tempfile.TemporaryDirectory() as root:
        engine = IdeaTreeEngine(dict(id='r'), ResearchStore(Path(root)), dict(url='http://model.test/v1/chat/completions', token='t'))
        return engine, attempts, sleeps


def test_transport_retries_transient_429_then_succeeds(monkeypatch):
    # Issue #1232: one 429 with Retry-After: 1, then success, must continue.
    engine, attempts, sleeps = transport_with_faults(monkeypatch, [rate_limit_error])
    assert engine.transport('system', dict(a=1)) == ('{}', 7)
    assert len(attempts) == 2
    assert sum(sleeps) == pytest.approx(1.0)


def test_transport_gives_up_after_bounded_429_retries(monkeypatch):
    # Repeated 429s terminate after the existing two-attempt budget, with a clear reason.
    engine, attempts, sleeps = transport_with_faults(monkeypatch, [rate_limit_error, rate_limit_error])
    with pytest.raises(RuntimeError, match='Model HTTP 429: retry budget exhausted after 2 attempts'):
        engine.transport('system', dict(a=1))
    assert len(attempts) == 2
    assert sum(sleeps) == pytest.approx(1.0)


def test_transport_does_not_retry_permanent_quota_429(monkeypatch):
    # A 429 that reports exhausted quota/billing is permanent, not transient.
    engine, attempts, sleeps = transport_with_faults(monkeypatch, [lambda url: rate_limit_error(url, error_type='insufficient_quota')])
    with pytest.raises(RuntimeError, match='Model HTTP 429: permanent quota error, not retried'):
        engine.transport('system', dict(a=1))
    assert len(attempts) == 1
    assert sleeps == []


def test_transport_retry_wait_respects_pause(monkeypatch):
    # A pause issued while waiting out a 429 must interrupt the wait, not the retry.
    engine, attempts, sleeps = transport_with_faults(monkeypatch, [rate_limit_error])

    def pausing_sleep(seconds):
        sleeps.append(seconds)
        engine.stop_action = 'pause'

    monkeypatch.setattr(time, 'sleep', pausing_sleep)
    with pytest.raises(Interrupted):
        engine.transport('system', dict(a=1))
    assert len(attempts) == 1


def test_transport_still_retries_500_then_succeeds(monkeypatch):
    # Control case: the pre-existing 5xx retry is unchanged by the 429 fix.
    def server_error(url):
        return urllib.error.HTTPError(url, 503, 'Service Unavailable', {}, io.BytesIO(b'{"error":"original temporary provider cause"}'))

    engine, attempts, sleeps = transport_with_faults(monkeypatch, [server_error])
    assert engine.transport('system', dict(a=1)) == ('{}', 7)
    assert len(attempts) == 2
    assert sum(sleeps) == pytest.approx(0.5)


def test_a_fenced_json_answer_is_read_as_json():
    # Kimi answers the ideation prompt with ```json ... ```.
    assert parse_json('```json\n{"candidates": []}\n```') == {'candidates': []}
    assert parse_json('  ```\n{"a": 1}\n```  ') == {'a': 1}
    assert parse_json('{"a": 1}') == {'a': 1}
    with pytest.raises(ValueError):
        parse_json('```python\n{"a": 1}\n```')
    with pytest.raises(ValueError):
        parse_json('Here it is: {"a": 1}')


def test_every_stage_follows_the_models_own_thinking_level(monkeypatch):
    """No stage asks for an effort: the request leaves `reasoning_effort` out so the
    model profile's own thinking level applies, and a settings payload written before
    the per-stage control was removed is simply not carried into the research."""
    sent = []

    class Reply:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, *_):
            return json.dumps(dict(choices=[dict(message=dict(content='{"text": "design"}'))], usage=dict(total_tokens=7))).encode()

    def urlopen(request, timeout):
        sent.append(json.loads(request.data))
        return Reply()

    monkeypatch.setattr('urllib.request.urlopen', urlopen)
    settings = Settings(templateId='water-treatment-materials/v1', roleThinkingEfforts=dict(design='max')).model_dump()
    assert 'roleThinkingEfforts' not in settings
    with tempfile.TemporaryDirectory() as root:
        state = dict(id='r', projectId='p', sessionId='s', settings=settings, template=snapshot('water-treatment-materials/v1'),
                     round=0, tokens=0, usageKnown=True, nodes=[node('ROOT', None, 'Goal', 'direction', 0)])
        engine = IdeaTreeEngine(state, ResearchStore(Path(root)), dict(url='http://model.test/v1/chat/completions', token='t'))
        asyncio.run(engine.ask('design', {}))
        assert 'reasoning_effort' not in sent[-1]
        engine.transport('system', dict(a=1))
        assert 'reasoning_effort' not in sent[-1]


RESEARCH_READ_SCRIPT = """
import sys
from pathlib import Path
from sciencediscovery_evolve.vendor.idea_tree.research import ResearchStore

root = Path(sys.argv[1])
store = ResearchStore(root)
expected = "".join(chr(code) for code in (0x8109, 0x86cb, 0x767d))
one = store.read("p", "s", "r1")
assert one["title"] == expected, one["title"]
many = store.list("p", "s")
assert [row["id"] for row in many] == ["r1"], [row["id"] for row in many]
assert many[0]["title"] == expected, many[0]["title"]
try:
    (root / "p" / "s" / "r1.json").read_text()
except UnicodeDecodeError:
    pass
else:
    raise SystemExit("this child decodes as UTF-8, so the probe above proves nothing")
print("ok")
"""


def read_on_a_host_with_ascii_as_the_default_codec(root, script, *arguments):
    """Run `script` where `read_text()` with no encoding would decode as ASCII.

    cp936 and ASCII fail on the same bytes, so this reproduces the reported host
    on any runner instead of only on Windows.
    """
    import os
    import subprocess
    import sys

    environment = {**os.environ, "PYTHONUTF8": "0", "LC_ALL": "C", "LANG": "C", "PYTHONIOENCODING": "ascii"}
    source = str(Path(__file__).resolve().parents[1] / "src")
    environment["PYTHONPATH"] = os.pathsep.join(filter(None, [source, environment.get("PYTHONPATH")]))
    completed = subprocess.run([sys.executable, "-c", script, str(root), *arguments],
                               capture_output=True, text=True, env=environment)
    assert completed.returncode == 0, completed.stderr
    return completed.stdout.strip()


def test_a_research_with_non_ascii_content_reads_on_a_non_utf8_host(tmp_path):
    store = ResearchStore(tmp_path)
    store.save(dict(projectId="p", sessionId="s", id="r1", status="completed",
                    title="".join(chr(code) for code in (0x8109, 0x86cb, 0x767d)),
                    createdAt=now(), nodes={}, materials={}))
    # Both the single read and the directory scan: `get` after a restart goes
    # through read(), `list` always goes through the scan (research_service.py).
    assert read_on_a_host_with_ascii_as_the_default_codec(tmp_path, RESEARCH_READ_SCRIPT) == "ok"
