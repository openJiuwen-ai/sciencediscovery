
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))
import asyncio
import copy
import io
import json
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
from pathlib import Path

from sciencediscovery_evolve.vendor.idea_tree import research as research_module
from sciencediscovery_evolve.vendor.idea_tree.research import BudgetReached, IdeaTreeEngine, Interrupted, ResearchStore, node, now, parse_json
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

    async def test_empty_or_truncated_stage_consumes_the_correction_and_preserves_usage(self):
        # A stage gets one correction, and an empty answer is a content failure like a
        # malformed one, so it takes that correction instead of ending the stage before
        # the branch is reached (#1327). Both calls' usage still lands, and the failure
        # names the stage.
        for raw in (None, '', '  '):
            calls = []
            async def truncated(role, payload):
                calls.append(payload)
                return raw, 14
            self.state['tokens'] = 0
            engine = IdeaTreeEngine(self.state, self.store, {}, truncated)
            with self.assertRaisesRegex(ValueError, 'design: invalid model result after one correction: empty or truncated model output'):
                await engine.ask('design', {})
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[1]['correction'], 'empty or truncated model output; answer again with the required JSON')
            self.assertEqual(self.state['tokens'], 28)
            self.assertEqual(engine.reserved, 0)
            persisted = self.store.read('p', 's', 'research-test')
            self.assertEqual(persisted['tokens'], 28)
            self.assertEqual(persisted['activities'][-1]['status'], 'failed')
            self.assertIn('empty or truncated', persisted['activities'][-1]['error'])

    async def test_an_empty_answer_is_retried_once_and_can_succeed(self):
        # #1327: an empty answer used to raise before the correction branch, so the
        # stage never asked again. One more call is enough when the model was merely
        # empty once, and the correction tells it what was wrong.
        calls = []
        async def flaky(role, payload):
            calls.append(payload)
            if len(calls) == 1:
                return '', 14
            return json.dumps(dict(text='design output')), 14
        engine = IdeaTreeEngine(self.state, self.store, {}, flaky)
        result = await engine.ask('design', {})
        self.assertEqual(result['text'], 'design output')
        self.assertEqual(len(calls), 2)
        self.assertIn('empty or truncated', calls[1]['correction'])
        self.assertEqual(self.state['tokens'], 28)

    async def test_a_research_survives_an_empty_ideation_answer(self):
        # The run-level shape of #1327: the ideate stage answers empty once, the
        # correction is enough, and the research completes instead of settling
        # `interrupted`.
        self.state['settings'].update(maxRounds=1, candidatesPerRound=1, maxSearchRounds=1)
        ideate = []
        async def model(role, payload):
            raw, tokens = await self.model(role, payload)
            if role == 'ideate':
                ideate.append(payload)
                if len(ideate) == 1:
                    return '', 14
            return raw, tokens
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'completed', self.state['reason'])
        self.assertEqual(len(ideate), 2)
        self.assertIn('empty or truncated', ideate[1]['correction'])

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
        self.assertNotEqual(self.state['status'], 'budget_exhausted', 'a user pause stays resumable')
        self.assertEqual(len(self.state['nodes']), 1)
        self.assertEqual(self.state['tokens'], 100)

    async def test_token_budget_and_missing_usage(self):
        self.state['settings']['maxTokens'] = 1
        await IdeaTreeEngine(self.state, self.store, {}, self.model).run()
        # A spent budget is terminal and says so; a user pause is not the same outcome.
        self.assertEqual(self.state['status'], 'budget_exhausted')
        self.assertIn('Remaining token budget cannot fund the next stage', self.state['reason'])
        self.assertIn('Used 0 of 1 tokens', self.state['reason'])
        self.assertEqual(self.calls, [])
        self.state['settings']['maxTokens'] = 100000
        async def unknown(role, payload):
            raw, _ = await self.model(role, payload)
            return raw, None
        await IdeaTreeEngine(self.state, self.store, {}, unknown).run()
        self.assertEqual(self.state['status'], 'budget_exhausted')
        self.assertIn('budget', self.state['reason'])
        # The budget was spent by the conservative admission reserve, not measured
        # usage: the persisted reason must not claim a reported count of 0.
        self.assertIn('Reported token usage is unavailable', self.state['reason'])
        self.assertNotIn('Used 0 of', self.state['reason'])
        self.assertFalse(self.state['usageKnown'])
        self.assertGreater(self.state['unreportedBudgetEstimate'], 0)

    async def test_a_user_end_outranks_a_budget_exhaustion(self):
        # Issue #1455: a stop request can land after run()'s last check_stop() and before
        # the budget reservation, which then raises BudgetReached. The irreversible end
        # request must win and stay terminal instead of becoming a resumable pause.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        from fastapi import HTTPException

        class StopBeforeBudgetLock(asyncio.Lock):
            """Set the user's stop at that suspension point, as a concurrent stop does."""
            async def acquire(self):
                engine.stop_action = 'end'
                return await super().acquire()

        self.state['settings']['maxTokens'] = 1
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        engine.usage_lock = StopBeforeBudgetLock()
        await engine.run()
        self.assertEqual(self.state['status'], 'ended')
        self.assertEqual(self.state['reason'], 'Ended by user')
        self.assertNotIn('token budget', self.state['reason'])
        self.assertEqual(self.calls, [])
        # `ended` is irreversible: a `continue` must be refused, unlike `paused`.
        with patch.object(service, '_store', self.store), \
                patch.object(service, 'start', side_effect=AssertionError('must not start')):
            continuation = service.Command(projectId='p', sessionId='s', researchId='research-test',
                                           operation='continue', llm=dict(url='http://localhost', token='local'))
            with self.assertRaises(HTTPException) as conflict:
                await service.command(continuation)
            self.assertEqual(conflict.exception.status_code, 409)
            self.assertIn('has ended', conflict.exception.detail)

    async def test_a_user_pause_outranks_a_budget_exhaustion(self):
        # The pause request must resolve as the user's pause, not as the budget's
        # terminal `budget_exhausted` state.
        class StopBeforeBudgetLock(asyncio.Lock):
            async def acquire(self):
                engine.stop_action = 'pause'
                return await super().acquire()

        self.state['settings']['maxTokens'] = 1
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        engine.usage_lock = StopBeforeBudgetLock()
        await engine.run()
        self.assertEqual(self.state['status'], 'paused')
        self.assertEqual(self.state['reason'], 'Paused by user')
        self.assertEqual(self.calls, [])

    async def test_budget_exhaustion_without_a_stop_request_stays_terminal(self):
        # Control: the fix must not turn plain budget exhaustion into a resumable pause.
        self.state['settings']['maxTokens'] = 1
        await IdeaTreeEngine(self.state, self.store, {}, self.model).run()
        self.assertEqual(self.state['status'], 'budget_exhausted')
        self.assertIn('Remaining token budget cannot fund the next stage', self.state['reason'])
        self.assertIn('Used 0 of 1 tokens', self.state['reason'])

    async def test_service_end_while_a_stage_hits_the_budget_settles_ended(self):
        # The user-visible journey: `end` reaches the in-flight engine as a flag, then
        # the in-flight stage raises BudgetReached before any stop check.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        entered, release = asyncio.Event(), asyncio.Event()

        async def ask(engine, role, payload, check=None):
            entered.set()
            await release.wait()
            raise BudgetReached('Remaining token budget cannot fund the next stage')

        with patch.object(service, '_store', self.store), patch.object(IdeaTreeEngine, 'ask', ask):
            created = await service.command(service.Command(projectId='p', sessionId='s', operation='create',
                                                            objective='Goal', llm=dict(url='http://localhost', token='local')))
            identifier = created['research']['id']
            await entered.wait()
            ending = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier,
                                                           operation='end'))
            self.assertEqual(ending['research']['status'], 'pausing')
            release.set()
            await service._running[identifier][1]
            settled = service.state_for('p', 's', identifier)
            self.assertEqual(settled['status'], 'ended')
            self.assertEqual(settled['reason'], 'Ended by user')

    async def test_a_branch_at_the_ceiling_records_the_direction_it_could_not_place(self):
        """F8: a candidate parent at maxDepth - 1 leaves allowance 0, so the candidate
        attaches directly under it. The direction the model had to supply must be kept
        on the candidate rather than silently dropped."""
        self.state['settings'].update(maxDepth=3, maxRounds=1, candidatesPerRound=1,
                                      maxSearchRounds=3, maxActiveDirections=3)
        root = self.state['nodes'][0]
        deep = node('1', root['id'], 'Deep candidate', 'candidate', 2)
        deep.update(status='done', score=6)
        sibling = node('2', root['id'], 'Sibling direction', 'direction', 1)
        sibling['insight'] = 'sibling insight'
        root['childrenIds'] = ['1', '2']
        self.state['nodes'].extend([deep, sibling])
        async def model(role, payload):
            if role == 'ideate':
                return json.dumps(dict(candidates=[dict(parentId='1', direction='Mechanism follow-up',
                                                         refinements=['step two'], hypothesis='Child under the ceiling')],
                                       reason='the ceiling leaves no room for a direction node')), 50
            return await self.model(role, payload)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        child = next((n for n in self.state['nodes'] if n['hypothesis'] == 'Child under the ceiling'), None)
        self.assertIsNotNone(child)
        self.assertEqual(child['depth'], 3)
        self.assertEqual(child.get('trimmedDirection'), 'Mechanism follow-up')

    async def test_an_unusable_ideation_round_is_skipped_not_fatal(self):
        """Measured in practice: one bad field in one ideation answer (`targetedWeakness`
        outside 1-2000 characters) settled a whole standard research as `interrupted`
        after its single correction. The round is skipped instead, and the next
        ideation continues the research."""
        self.state['settings'].update(maxRounds=3, candidatesPerRound=1, maxSearchRounds=6,
                                      maxActiveDirections=3, explorationSlots=0)
        calls = {'ideate': 0}
        async def model(role, payload):
            if role == 'ideate':
                calls['ideate'] += 1
                # Both attempts of the first round answer with an empty hypothesis
                # (required to be 1-4000 characters), so `ask` exhausts its single
                # correction and the round has to be skipped rather than fatal.
                if calls['ideate'] <= 2:
                    return json.dumps(dict(candidates=[dict(parentId=payload['selectedParentIds'][0], direction='Bad', hypothesis='')], reason='broken')), 40
            return await self.model(role, payload)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'completed')
        self.assertGreaterEqual(calls['ideate'], 2)
        self.assertTrue([n for n in self.state['nodes'] if n['kind'] == 'candidate'])
        # The old behaviour settled this as `interrupted` after the single
        # correction; the research now survives the bad round and still ends with a
        # candidate, which is the whole point of the change.

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

    def assert_expansion_constraints(self, identifier, kind, parent_depth, ceiling, required, allowed, refinements):
        self.state['settings']['maxDepth'] = ceiling
        parent = node(identifier, None, 'Parent', kind, parent_depth)
        parent['status'] = 'done'
        self.state['nodes'] = [parent]
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        constraints = engine.expansion_constraints(parent)
        self.assertEqual(constraints, dict(parentId=identifier, remainingDepth=ceiling - parent_depth,
            maxPathSteps=ceiling - parent_depth - 1, directionRequired=required,
            directionNodeAllowed=allowed, maxRefinements=refinements))
        proposal = dict(parentId=identifier, refinements=['Refinement'] * refinements, hypothesis='Child')
        if required:
            proposal['direction'] = 'Follow-up'
        _, path = engine.proposal_path(proposal)
        self.assertEqual(len(path), refinements + int(allowed))
        self.assertEqual(parent_depth + len(path) + 1, ceiling)

    def test_root_expansion_reserves_only_the_candidate_level(self):
        self.assert_expansion_constraints('ROOT', 'direction', 0, 5, True, False, 4)

    def test_depth_one_root_needs_no_direction(self):
        self.assert_expansion_constraints('ROOT', 'direction', 0, 1, False, False, 0)

    def test_direction_expansion_reserves_the_candidate_level(self):
        self.assert_expansion_constraints('1', 'direction', 3, 5, False, False, 1)

    def test_last_level_direction_has_no_refinement_budget(self):
        self.assert_expansion_constraints('1', 'direction', 4, 5, False, False, 0)

    def test_candidate_expansion_reserves_direction_and_candidate_levels(self):
        self.assert_expansion_constraints('1', 'candidate', 3, 5, True, True, 0)

    def test_last_level_candidate_keeps_direction_as_metadata(self):
        self.assert_expansion_constraints('1', 'candidate', 4, 5, True, False, 0)

    async def test_ideation_and_correction_receive_selected_parent_constraints(self):
        attempts = []
        async def model(role, payload):
            if role == 'ideate':
                attempts.append(payload)
                constraints = payload['selectedParentConstraints']
                self.assertEqual([entry['parentId'] for entry in constraints], payload['selectedParentIds'])
                if len(attempts) == 1:
                    # Trigger the existing correction without altering the tree.
                    return json.dumps(dict(candidates=[dict(parentId='missing', hypothesis='Invalid')], reason='Retry')), 10
                entry = constraints[0]
                proposal = dict(parentId=entry['parentId'], refinements=[], hypothesis=f"Child {payload['round']}")
                if entry['directionRequired']:
                    proposal['direction'] = 'New direction'
                return json.dumps(dict(candidates=[proposal], reason='Fits the parent budget')), 10
            return await self.model(role, payload)
        self.state['settings'].update(maxDepth=3, maxRounds=2)
        await IdeaTreeEngine(self.state, self.store, {}, model).run()
        self.assertEqual(self.state['status'], 'completed', self.state['reason'])
        self.assertEqual(len(attempts), 3)
        self.assertIn('correction', attempts[1])
        self.assertEqual(attempts[0]['selectedParentConstraints'], attempts[1]['selectedParentConstraints'])
        self.assertTrue(all(n['depth'] <= 3 for n in self.state['nodes']))
        self.assertEqual(sum(n['kind'] == 'candidate' for n in self.state['nodes']), 2)

    def test_a_proposal_past_the_ceiling_is_trimmed_not_rejected(self):
        """maxDepth is a ceiling, not a target: a model that adds one refinement too
        many keeps the steps that fit. Raising instead cost the whole research — a
        stage gets one correction, so a run at round 3 with 585K tokens spent settled
        as `interrupted` on `ideate: Proposal exceeds maxDepth`."""
        self.state['settings']['maxDepth'] = 3
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        parent = node('1', 'ROOT', 'Initial hypothesis', 'candidate', 1)
        parent.update(status='done', score=5)
        self.state['nodes'][0]['childrenIds'].append('1')
        self.state['nodes'].append(parent)
        selected_parent, path = engine.proposal_path(dict(parentId='1', direction='Mechanism follow-up',
                                                          refinements=['step two', 'step three'], hypothesis='Child hypothesis'))
        self.assertEqual(selected_parent['id'], '1')
        # depth 1 + [direction] + one refinement = 3, so only the direction fits.
        self.assertEqual(path, ['Mechanism follow-up'])

    def test_a_proposal_that_fits_the_ceiling_keeps_every_step(self):
        self.state['settings']['maxDepth'] = 5
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        parent = node('1', 'ROOT', 'Initial hypothesis', 'candidate', 1)
        parent.update(status='done', score=5)
        self.state['nodes'][0]['childrenIds'].append('1')
        self.state['nodes'].append(parent)
        _, path = engine.proposal_path(dict(parentId='1', direction='Mechanism follow-up',
                                            refinements=['step two'], hypothesis='Child hypothesis'))
        self.assertEqual(path, ['Mechanism follow-up', 'step two'])

    def test_a_trimmed_direction_is_reported_and_an_echoed_one_is_not(self):
        """Only a direction the ceiling actually removed is reported. A direction
        parent and an explicit ROOT parent never contribute their `direction` to the
        path, so a model that fills the field there must not be recorded as trimmed."""
        self.state['settings']['maxDepth'] = 3
        engine = IdeaTreeEngine(self.state, self.store, {}, self.model)
        deep = node('1', 'ROOT', 'Initial hypothesis', 'candidate', 2)
        deep.update(status='done', score=5)
        direction_parent = node('2', 'ROOT', 'A direction', 'direction', 1)
        self.state['nodes'][0]['childrenIds'] = ['1', '2']
        self.state['nodes'].extend([deep, direction_parent])
        # Candidate parent at maxDepth - 1: allowance 0, so the direction is removed.
        self.assertEqual(engine.trimmed_direction(dict(parentId='1', direction='Mechanism follow-up',
                                                       refinements=['step two'])), 'Mechanism follow-up')
        # Direction parent echoing a direction: nothing is removed.
        self.assertIsNone(engine.trimmed_direction(dict(parentId='2', direction='Echoed direction',
                                                        refinements=['step two'])))
        # ROOT proposal carrying a direction: the parent is ROOT, so nothing is removed.
        self.assertIsNone(engine.trimmed_direction(dict(parentId='ROOT', direction='New direction')))
        # A candidate parent with room keeps the direction, so nothing is removed.
        self.state['settings']['maxDepth'] = 5
        self.assertIsNone(engine.trimmed_direction(dict(parentId='1', direction='Mechanism follow-up',
                                                        refinements=['step two'])))

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
        # A model that never answers now costs one attempt per round plus its single
        # correction, because a bad round is skipped instead of ending the research;
        # a run that still produced no candidate settles `interrupted` with the error.
        self.assertEqual(len(self.calls), 6)
        self.assertEqual(self.state['status'], 'interrupted')
        self.assertEqual(self.state['tokens'], 30)
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
            # A persisted running flag after a process restart is never an auto-resume
            # instruction, but the read path may not settle it: the verdict belongs to
            # the startup reconciliation, not to whichever request reads first (#1456).
            saved = self.store.read('p', 's', identifier)
            saved['status'] = 'running'
            self.store.save(saved)
            path = self.store.path('p', 's', identifier)
            before = path.read_bytes()
            self.assertEqual(service.state_for('p', 's', identifier)['status'], 'running')
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(service.reconcile_orphaned_researches(), 1)
            restarted = self.store.read('p', 's', identifier)
            self.assertEqual(restarted['status'], 'interrupted')
            self.assertEqual(restarted['reason'], 'Service restarted; continue manually')
            self.assertEqual(service.state_for('p', 's', identifier)['status'], 'interrupted')
            # Already settled: a second boot has nothing to do.
            self.assertEqual(service.reconcile_orphaned_researches(), 0)
            ended = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='end'))
            self.assertEqual(ended['research']['status'], 'ended')
            self.assertNotIn(identifier, service._running)

    async def test_a_research_ended_in_flight_comes_back_ended_after_a_restart(self):
        # #1464: `end` during a live run only reached the engine's memory, so a
        # restart before the in-flight stage returned folded the user's verdict into
        # `interrupted` and `continue` was accepted again. The request is persisted
        # while the run is still `pausing`, and the restart maps it to `ended`.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        from fastapi import HTTPException
        entered = asyncio.Event()
        async def ask(engine, role, payload, check=None):
            entered.set()
            await asyncio.Event().wait()  # the process dies before this call returns
        with patch.object(service, '_store', self.store), patch.object(service, '_running', {}), \
                patch.object(IdeaTreeEngine, 'ask', ask):
            created = await service.command(service.Command(projectId='p', sessionId='s', operation='create', objective='Goal', llm=dict(url='http://localhost', token='local')))
            identifier = created['research']['id']
            await entered.wait()
            # The stage records itself as running before it awaits the model call.
            service._running[identifier][0].state.setdefault('activities', []).append(
                dict(role='design', nodeId='ROOT', round=1, status='running', startedAt=now(), finishedAt=None, error=None))
            ending = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='end'))
            # The runtime status is still `pausing`: the SSE stream keeps running and
            # the engine settles the run normally.
            self.assertEqual(ending['research']['status'], 'pausing')
            # The stop intent itself is on disk while the run is still in flight.
            in_flight = self.store.read('p', 's', identifier)
            self.assertEqual(in_flight['status'], 'pausing')
            self.assertEqual(in_flight['pendingStop'], 'end')
            task = service._running[identifier][1]
            # The process dies before the in-flight stage settles.
            service._running.clear()
            self.assertEqual(service.reconcile_orphaned_researches(), 1)
            restarted = self.store.read('p', 's', identifier)
            self.assertEqual(restarted['status'], 'ended')
            self.assertEqual(restarted['reason'], 'Ended by user')
            self.assertEqual([a['status'] for a in restarted['activities']], ['stopped'])
            self.assertNotIn('pendingStop', restarted)
            self.assertEqual(service.state_for('p', 's', identifier)['status'], 'ended')
            with self.assertRaises(HTTPException) as conflict:
                await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='continue', llm=dict(url='http://localhost', token='local')))
            self.assertEqual(conflict.exception.status_code, 409)
            self.assertIn('has ended', conflict.exception.detail)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_a_graceful_shutdown_keeps_the_pending_end_for_the_next_boot(self):
        # The settle mark must survive any exit that did not settle the run: a
        # cancelled drive task (SIGINT/loop shutdown) leaves `pausing`, and clearing
        # the mark there would fold the user's `end` into `interrupted` on the next
        # boot again (#1464).
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        from fastapi import HTTPException
        entered = asyncio.Event()
        async def ask(engine, role, payload, check=None):
            entered.set()
            await asyncio.Event().wait()
        with patch.object(service, '_store', self.store), patch.object(service, '_running', {}), \
                patch.object(IdeaTreeEngine, 'ask', ask):
            created = await service.command(service.Command(projectId='p', sessionId='s', operation='create', objective='Goal', llm=dict(url='http://localhost', token='local')))
            identifier = created['research']['id']
            await entered.wait()
            service._running[identifier][0].state.setdefault('activities', []).append(
                dict(role='design', nodeId='ROOT', round=1, status='running', startedAt=now(), finishedAt=None, error=None))
            await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='end'))
            task = service._running[identifier][1]
            # Graceful shutdown: the drive task is cancelled before the in-flight call
            # returns, so the run never reaches a settle branch.
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            persisted = self.store.read('p', 's', identifier)
            self.assertEqual(persisted['status'], 'pausing')
            self.assertEqual(persisted['pendingStop'], 'end')
            self.assertEqual(service.reconcile_orphaned_researches(), 1)
            restarted = self.store.read('p', 's', identifier)
            self.assertEqual(restarted['status'], 'ended')
            self.assertEqual(restarted['reason'], 'Ended by user')
            self.assertEqual([a['status'] for a in restarted['activities']], ['stopped'])
            self.assertNotIn('pendingStop', restarted)
            with self.assertRaises(HTTPException) as conflict:
                await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='continue', llm=dict(url='http://localhost', token='local')))
            self.assertEqual(conflict.exception.status_code, 409)

    async def test_a_live_end_still_settles_ended_and_drops_the_persisted_stop(self):
        # #1464 keeps the existing invariants: `end` does not shortcut to `ended`
        # while the run is live (so the stream, the model grant and the one research
        # per Session guard stay as they were), the engine settles the same
        # `ended` / `Ended by user`, and the persisted mark does not outlive it.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        from fastapi import HTTPException
        entered, release = asyncio.Event(), asyncio.Event()
        async def ask(engine, role, payload, check=None):
            entered.set()
            await release.wait()
            engine.check_stop()
            return dict(candidates=[], reason='Done')
        with patch.object(service, '_store', self.store), patch.object(service, '_running', {}), \
                patch.object(IdeaTreeEngine, 'ask', ask):
            created = await service.command(service.Command(projectId='p', sessionId='s', operation='create', objective='Goal', llm=dict(url='http://localhost', token='local')))
            identifier = created['research']['id']
            await entered.wait()
            ending = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='end'))
            self.assertEqual(ending['research']['status'], 'pausing')
            self.assertEqual(service.state_for('p', 's', identifier)['status'], 'pausing')
            # No second research is admitted in this Session while the first settles.
            with self.assertRaises(HTTPException) as conflict:
                await service.command(service.Command(projectId='p', sessionId='s', operation='create', objective='Another goal', llm=dict(url='http://localhost', token='local')))
            self.assertEqual(conflict.exception.status_code, 409)
            task = service._running[identifier][1]
            release.set()
            await task
            settled = self.store.read('p', 's', identifier)
            self.assertEqual(settled['status'], 'ended')
            self.assertEqual(settled['reason'], 'Ended by user')
            self.assertNotIn('pendingStop', settled)
            self.assertNotIn(identifier, service._running)

    async def test_a_research_paused_in_flight_comes_back_paused_after_a_restart(self):
        # The same restart window for `pause`: the user asked to keep the run
        # resumable, so the recovered status is `paused`, not `interrupted`. A
        # record written before the mark existed keeps the interrupted verdict.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        entered = asyncio.Event()
        async def ask(engine, role, payload, check=None):
            entered.set()
            await asyncio.Event().wait()
        with patch.object(service, '_store', self.store), patch.object(service, '_running', {}), \
                patch.object(IdeaTreeEngine, 'ask', ask):
            created = await service.command(service.Command(projectId='p', sessionId='s', operation='create', objective='Goal', llm=dict(url='http://localhost', token='local')))
            identifier = created['research']['id']
            await entered.wait()
            # The stage records itself as running before it awaits the model call.
            service._running[identifier][0].state.setdefault('activities', []).append(
                dict(role='design', nodeId='ROOT', round=1, status='running', startedAt=now(), finishedAt=None, error=None))
            pausing = await service.command(service.Command(projectId='p', sessionId='s', researchId=identifier, operation='pause'))
            self.assertEqual(pausing['research']['status'], 'pausing')
            self.assertEqual(self.store.read('p', 's', identifier)['pendingStop'], 'pause')
            task = service._running[identifier][1]
            service._running.clear()
            self.assertEqual(service.reconcile_orphaned_researches(), 1)
            restarted = self.store.read('p', 's', identifier)
            self.assertEqual(restarted['status'], 'paused')
            self.assertEqual(restarted['reason'], 'Paused by user')
            self.assertEqual([a['status'] for a in restarted['activities']], ['stopped'])
            self.assertNotIn('pendingStop', restarted)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        # The dead run's own final save is not part of this simulation; drop it so the
        # next reconciliation sees only the legacy record.
        self.store.path('p', 's', identifier).unlink()
        # A legacy pausing record has no mark: it keeps the restart verdict.
        legacy = copy.deepcopy(self.state)
        legacy.update(id='research-legacy', status='pausing', activities=[
            dict(role='design', nodeId='ROOT', round=1, status='running', startedAt=now(), finishedAt=None, error=None)])
        self.store.save(legacy)
        with patch.object(service, '_store', self.store), patch.object(service, '_running', {}):
            self.assertEqual(service.reconcile_orphaned_researches(), 1)
        settled = self.store.read('p', 's', 'research-legacy')
        self.assertEqual(settled['status'], 'interrupted')
        self.assertEqual(settled['reason'], 'Service restarted; continue manually')
        self.assertEqual(settled['activities'][0]['status'], 'stopped')

    async def test_reading_a_research_never_writes_it(self):
        # #1456: list/get/events are reads. A `running` record with no engine in
        # this process is a restart orphan, but only the startup reconciliation may
        # settle it: the old read path persisted `interrupted` and closed the running
        # activities, once per streamed frame and even for an archived Session.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        self.state.update(status='running', activities=[
            dict(role='design', nodeId='ROOT', round=1, status='running', startedAt=now(), finishedAt=None, error=None)])
        self.store.save(self.state)
        path = self.store.path('p', 's', 'research-test')
        before = path.read_bytes()
        with patch.object(service, '_store', self.store), patch.object(service, '_running', {}):
            listed = await service.command(service.Command(projectId='p', sessionId='s', operation='list'))
            self.assertEqual([item['research']['status'] for item in listed['items']], ['running'])
            self.assertEqual(path.read_bytes(), before, 'list must not rewrite the research')
            fetched = await service.command(service.Command(projectId='p', sessionId='s', researchId='research-test', operation='get'))
            self.assertEqual(fetched['research']['status'], 'running')
            self.assertEqual(path.read_bytes(), before, 'get must not rewrite the research')
            # The events path reads once before streaming and again on every frame.
            response = await service.events(service.Command(projectId='p', sessionId='s', researchId='research-test', operation='events'))
            frame = await response.body_iterator.__anext__()
            await response.body_iterator.aclose()
            self.assertEqual(json.loads(frame.split('data: ', 1)[1])['research']['status'], 'running')
            self.assertEqual(path.read_bytes(), before, 'the events stream must not rewrite the research')

    def test_startup_reconciliation_settles_only_orphans(self):
        # #1456: the restart verdict is one boot-time pass, not a read side effect.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        activity = dict(role='design', nodeId='ROOT', round=1, status='running', startedAt=now(), finishedAt=None, error=None)
        for identifier, status in [('research-running', 'running'), ('research-pausing', 'pausing'),
                                   ('research-paused', 'paused'), ('research-completed', 'completed')]:
            state = copy.deepcopy(self.state)
            state.update(id=identifier, status=status, activities=[dict(activity)])
            self.store.save(state)
        paused_bytes = self.store.path('p', 's', 'research-paused').read_bytes()
        completed_bytes = self.store.path('p', 's', 'research-completed').read_bytes()
        with patch.object(service, '_store', self.store), patch.object(service.log, 'info') as info:
            # A research this process is driving is not an orphan, even if this pass
            # is invoked again.
            with patch.object(service, '_running', {'research-running': (None, None)}):
                self.assertEqual(service.reconcile_orphaned_researches(), 1)
                info.assert_called_once_with('settled %d research(es) interrupted by a service restart', 1)
                still_running = self.store.read('p', 's', 'research-running')
                self.assertEqual(still_running['status'], 'running')
                self.assertEqual(still_running['activities'][0]['status'], 'running')
            info.reset_mock()
            self.assertEqual(service.reconcile_orphaned_researches(), 1)
            info.assert_called_once_with('settled %d research(es) interrupted by a service restart', 1)
            info.reset_mock()
            self.assertEqual(service.reconcile_orphaned_researches(), 0)
            info.assert_not_called()
        for identifier in ('research-running', 'research-pausing'):
            settled = self.store.read('p', 's', identifier)
            self.assertEqual(settled['status'], 'interrupted')
            self.assertEqual(settled['reason'], 'Service restarted; continue manually')
            self.assertEqual(settled['activities'][0]['status'], 'stopped')
            self.assertTrue(settled['activities'][0]['finishedAt'])
            self.assertEqual(settled['activities'][0]['error'], 'Service restarted')
        # Terminal and user-paused researches are left exactly as they were.
        self.assertEqual(self.store.path('p', 's', 'research-paused').read_bytes(), paused_bytes)
        self.assertEqual(self.store.path('p', 's', 'research-completed').read_bytes(), completed_bytes)
        self.assertEqual(self.store.read('p', 's', 'research-paused')['activities'][0]['status'], 'running')

    async def test_service_refuses_to_continue_a_budget_exhausted_research(self):
        # The Python lifecycle must reject the terminal budget state too, even if a
        # caller bypasses the API client's own resumability check.
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        from fastapi import HTTPException
        self.state.update(status='budget_exhausted',
                          reason='Remaining token budget cannot fund the next stage. Used 10 of 5 tokens')
        self.store.save(self.state)
        with patch.object(service, '_store', self.store), \
                patch.object(service, 'start', side_effect=AssertionError('must not start')):
            continuation = service.Command(projectId='p', sessionId='s', researchId='research-test', operation='continue',
                                           llm=dict(url='http://localhost', token='local'))
            with self.assertRaises(HTTPException) as conflict:
                await service.command(continuation)
            self.assertEqual(conflict.exception.status_code, 409)
            self.assertIn('increase the token limit', conflict.exception.detail)
            # pause/end may not overwrite the terminal state into a resumable one.
            for operation in ('pause', 'end'):
                answer = await service.command(service.Command(projectId='p', sessionId='s', researchId='research-test', operation=operation))
                self.assertEqual(answer['research']['status'], 'budget_exhausted')
            self.assertEqual(service.state_for('p', 's', 'research-test')['status'], 'budget_exhausted')

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


def test_a_raw_control_character_inside_a_string_does_not_end_the_stage():
    """A live model writes an unescaped newline into a multi-line field. A stage gets
    one correction, so rejecting that character ends a research that already spent
    its budget on three rounds; the character is read as text instead."""
    assert parse_json('{"text": "line one\nline two"}') == {'text': 'line one\nline two'}
    assert parse_json('{"text": "a\tb"}') == {'text': 'a\tb'}
    assert parse_json('```json\n{"text": "x\r\ny"}\n```') == {'text': 'x\r\ny'}
    # A genuinely broken answer still raises so the stage can correct it.
    with pytest.raises(ValueError):
        parse_json('{"text": ')


def test_two_consecutive_json_objects_are_merged_not_rejected():
    """A live model sometimes answers with two objects back to back; `json.loads`
    stops at "Extra data: line N column 1" and a stage gets one correction, so the
    whole research used to settle `interrupted`. The objects are merged instead."""
    assert parse_json('{"candidates": []}\n{"reason": "merged"}') == {'candidates': [], 'reason': 'merged'}
    assert parse_json('```json\n{"a": 1}\n{"b": 2}\n```') == {'a': 1, 'b': 2}
    # Trailing content that is not JSON still fails, so genuine garbage is reported.
    with pytest.raises(ValueError):
        parse_json('{"a": 1}\nnot json at all')


def test_two_objects_that_carry_the_same_key_keep_the_later_value():
    """The merge is a tolerance for a malformed answer, so its two boundary rules are
    pinned rather than left to `{**a, **b}`: a key both objects carry keeps the later
    value (a list is replaced, not concatenated), and at most eight objects are read
    — a ninth re-raises the original `Extra data` error instead of merging forever."""
    assert parse_json('{"a": 1}\n{"a": 2}') == {'a': 2}
    assert parse_json('{"candidates": [1]}\n{"candidates": [2]}') == {'candidates': [2]}
    eight = '\n'.join(['{"k": 0}'] + ['{"k%d": %d}' % (index, index) for index in range(1, 8)])
    merged = parse_json(eight)
    assert merged['k'] == 0 and merged['k7'] == 7
    with pytest.raises(ValueError):
        parse_json(eight + '\n{"k8": 8}')


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


class LiveFrameTests(unittest.IsolatedAsyncioTestCase):
    """#1454: a live frame carries the change, not the whole tree."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ResearchStore(Path(self.temp.name))
        self.state = dict(id='research-test', projectId='p', sessionId='s', objective='Compare directions.',
                          materials='material', modelId='m', settings=Settings(candidatesPerRound=1, maxDepth=6).model_dump(),
                          template=snapshot('scientific-hypothesis-general/v1'), status='running', phase='ideate',
                          round=0, batch=[], batchCompleted=0, tokens=0, usageKnown=True, reason=None,
                          currentNodeId=None, createdAt=now(), updatedAt=now(),
                          nodes=[node('ROOT', None, 'Goal', 'direction', 0)])

    def grow(self, count, first=1):
        """`count` candidates, each with a design stage big enough to show in a payload."""
        for index in range(first, first + count):
            added = node(str(index), 'ROOT', f'Candidate {index}', 'candidate', 1)
            added['stages'] = {'design': {'text': 'a long design ' * 400}}
            self.state['nodes'].append(added)
            self.state['nodes'][0]['childrenIds'].append(str(index))

    def test_a_lean_node_never_builds_the_stage_serialisation_it_omits(self):
        # Building `result` and then deleting it was the expensive half of the frame:
        # for a designed candidate the string is as large as the node itself.
        from unittest.mock import patch
        self.grow(1)
        self.state['nodes'][1]['stages'] = {'design': {'text': 'x' * 8000}}
        engine = IdeaTreeEngine(self.state, self.store, {})
        calls = []
        real = json.dumps

        def counting(*args, **kwargs):
            calls.append(args[0] if args else kwargs)
            return real(*args, **kwargs)

        with patch.object(research_module.json, 'dumps', counting):
            lean = research_module.graph_node(self.state['nodes'][1], False)
            self.assertEqual(calls, [], 'a frame node serialises no stages')
            heavy = research_module.graph_node(self.state['nodes'][1], True)
        self.assertNotIn('result', lean)
        self.assertEqual(len(calls), 1, 'the read model still serialises stages once')
        self.assertEqual(json.loads(heavy['result']), {'design': {'text': 'x' * 8000}})

    def test_a_get_answer_still_carries_result_and_the_insight_log(self):
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        self.grow(1)
        self.state['nodes'][1]['insightRecords'] = [dict(id='insight-1', summary='lesson')]
        self.store.save(self.state)
        with patch.object(service, '_store', self.store):
            answer = service.view(self.state)
        node = answer['graph']['nodes'][1]
        self.assertEqual(json.loads(node['result']), {'design': {'text': 'a long design ' * 400}})
        self.assertEqual(node['insightRecords'], [dict(id='insight-1', summary='lesson')])
        self.assertNotIn('nodes', answer['research'])

    def test_the_first_frame_is_the_whole_tree_without_the_fields_the_view_does_not_draw(self):
        self.grow(12)
        self.store.save(self.state)
        graph, cursor = IdeaTreeEngine(self.state, self.store, {}).graph_frame(None)
        self.assertTrue(graph['full'])
        self.assertEqual(graph['revision'], self.state['revision'])
        self.assertEqual([n['id'] for n in graph['nodes']], [n['id'] for n in self.state['nodes']])
        self.assertEqual(len(graph['edges']), 12)
        for item in graph['nodes']:
            self.assertNotIn('result', item)
            self.assertNotIn('insightRecords', item)
            self.assertIn('stages', item)  # the node detail still renders it
        assert cursor[0] == self.state['revision']

    def test_a_frame_grows_with_the_change_not_with_the_tree(self):
        sizes = []
        totals = []
        for count in (4, 40):
            self.setUp()
            self.grow(count)
            self.store.save(self.state)
            full, cursor = IdeaTreeEngine(self.state, self.store, {}).graph_frame(None)
            self.state['nodes'][1]['status'] = 'done'
            self.state['nodes'][1]['score'] = 7.5
            self.store.save(self.state)
            delta, _ = IdeaTreeEngine(self.state, self.store, {}).graph_frame(cursor)
            self.assertFalse(delta['full'])
            self.assertEqual(delta['since'], cursor[0], 'the frame names the revision it was computed from')
            self.assertEqual([n['id'] for n in delta['nodes']], ['1'], 'only the node that changed')
            self.assertLess(len(json.dumps(delta)) * 2, len(json.dumps(full)),
                            'a whole frame is not a stand-in for a delta')
            sizes.append(len(json.dumps(delta)))
            totals.append(len(json.dumps(full)))
        self.assertEqual(sizes[0], sizes[1], 'the same one-node change costs the same in a 4-node and a 40-node tree')
        self.assertGreater(totals[1], totals[0] * 5, 'the whole tree does grow with the tree, which is what the delta avoids')

    def test_a_new_node_arrives_with_its_edge_and_no_old_node(self):
        self.store.save(self.state)
        _, cursor = IdeaTreeEngine(self.state, self.store, {}).graph_frame(None)
        self.grow(1)
        self.store.save(self.state)
        delta, _ = IdeaTreeEngine(self.state, self.store, {}).graph_frame(cursor)
        # ROOT's child list moved, so it travels too; the other candidates do not exist.
        self.assertEqual([n['id'] for n in delta['nodes']], ['ROOT', '1'])
        self.assertEqual(delta['edges'], [dict(source='ROOT', target='1', type='child', ordinal=1)])
        self.assertEqual(delta['removed'], [])

    def test_a_rewritten_stage_travels_and_an_unchanged_node_does_not(self):
        self.grow(1)
        self.store.save(self.state)
        _, cursor = IdeaTreeEngine(self.state, self.store, {}).graph_frame(None)
        # Nothing moved: the frame carries no node at all, only the research fields.
        quiet, cursor = IdeaTreeEngine(self.state, self.store, {}).graph_frame(cursor)
        self.assertEqual(quiet['nodes'], [])
        self.assertEqual(quiet['edges'], [])
        self.state['nodes'][1]['stages']['design'] = {'text': 'rewritten design'}
        self.store.save(self.state)
        delta, cursor = IdeaTreeEngine(self.state, self.store, {}).graph_frame(cursor)
        self.assertEqual([n['id'] for n in delta['nodes']], ['1'])
        self.assertEqual(delta['nodes'][0]['stages'], {'design': {'text': 'rewritten design'}})

    async def test_the_stream_sends_a_whole_tree_then_deltas_then_the_terminal_frame(self):
        from unittest.mock import patch
        from sciencediscovery_evolve.vendor.idea_tree import research_service as service
        self.grow(20)
        self.store.save(self.state)
        engine = IdeaTreeEngine(self.state, self.store, {})
        with patch.object(service, '_store', self.store), \
                patch.object(service, '_running', {'research-test': (engine, None)}):
            response = await service.events(service.Command(projectId='p', sessionId='s', researchId='research-test', operation='get'))
            frames = response.body_iterator
            first = json.loads((await anext(frames))[len('data: '):])
            self.assertTrue(first['graph']['full'], 'a fresh stream starts from the whole tree')
            self.assertEqual(len(first['graph']['nodes']), 21)
            self.assertNotIn('result', first['graph']['nodes'][0])
            self.assertEqual(first['research']['status'], 'running')
            self.assertNotIn('nodes', first['research'])

            self.state['nodes'][2]['status'] = 'done'
            self.state['nodes'][2]['insight'] = 'candidate insight'
            self.store.save(self.state)
            second = json.loads((await anext(frames))[len('data: '):])
            self.assertFalse(second['graph']['full'])
            self.assertEqual([n['id'] for n in second['graph']['nodes']], ['2'])
            self.assertEqual(second['graph']['nodes'][0]['insight'], 'candidate insight')
            self.assertEqual(second['graph']['since'], first['graph']['revision'])

            self.state['status'] = 'completed'
            self.store.save(self.state)
            last = json.loads((await anext(frames))[len('data: '):])
            self.assertEqual(last['research']['status'], 'completed')
            self.assertFalse(last['graph']['full'])
            with self.assertRaises(StopAsyncIteration):
                await anext(frames)

    def test_a_revision_moves_with_every_durable_checkpoint(self):
        self.store.save(self.state)
        first = self.state['revision']
        self.state['status'] = 'paused'
        self.store.save(self.state)
        self.assertEqual(self.state['revision'], first + 1)
        self.assertEqual(self.store.read('p', 's', 'research-test')['revision'], first + 1)
