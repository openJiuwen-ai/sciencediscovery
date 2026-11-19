#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { combinationJourneyProblems, deterministicJourneyProblems, loadCombinationJourneys, runDeterministicJourney } from "./combination-journeys.mjs";
import { runRealCombinationJourney } from "./combination-real-fixture.mjs";

const outputPath = process.env.COMBINATION_RESULTS?.trim()
  || join(process.env.CI_RESULTS_DIR?.trim() || join(process.cwd(), ".ci-results"), "st-combination-journeys", "summary.json");
const writeSummary = async (summary) => {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
};
const problems = await combinationJourneyProblems(process.cwd());
if (problems.length) {
  console.error(`Combination journey contract failed:\n- ${problems.join("\n- ")}`);
  await writeSummary({ status: "failed", problems });
  process.exitCode = 1;
} else {
  const journeys = await loadCombinationJourneys(process.cwd());
  const deterministic = journeys.map((journey) => runDeterministicJourney(journey.id, journey));
  const executionProblems = deterministic.flatMap((result) => deterministicJourneyProblems(result));
  const real = [];
  for (const journey of journeys) {
    try {
      real.push({ id: journey.id, ...(await runRealCombinationJourney(journey.id)) });
    } catch (error) {
      executionProblems.push(`${journey.id}: real fixture failed: ${error instanceof Error ? error.message : String(error)}`);
      real.push({ id: journey.id, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  await writeSummary({
    status: executionProblems.length ? "failed" : "passed",
    journeys: deterministic.map((result) => ({
      id: result.id,
      status: result.state.status,
      events: result.state.events,
      executedFaults: result.state.events.filter((event) => event.type === "fault").map((event) => event.fault),
      executedAssertions: result.state.events.filter((event) => event.type === "assertion").map((event) => event.assertion),
      contract: result.contract,
      realFixture: real.find((item) => item.id === result.id),
    })),
    problems: executionProblems,
  });
  if (executionProblems.length) {
    console.error(`Combination journey execution failed:\n- ${executionProblems.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Combination journey contract, deterministic execution and real fixture execution OK: ${deterministic.map((result) => `${result.id}(${result.state.events.length} events)`).join(", ")}`);
  }
}
