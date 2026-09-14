# Autonomous research workflow

The Lead first prepares literature and supplied evidence, honoring explicit retrieval skips,
then calls create_idea_research. The Python engine owns the loop: refine directions to the
configured execution depth → select pending leaves → design each leaf → independently
assess activity, stability and sustainability → aggregate → propagate → next batch.

Each successful stage is saved. Pausing prevents new stages; continuing reuses saved outputs.
A service interruption never automatically wakes research. The user can continue from the
Idea Tree panel. Round, candidate, depth, node and optional token limits are selected before
starting. Only leaves at the configured depth can be evaluated. Internal directions receive summaries,
not independent scores. Later batches add improved sibling leaves under those directions.

The Lead prepares inputs and explains outputs; it starts the engine once and does not dispatch individual leaves or maintain
an execution plan for it. Specialist Skills remain available for ordinary tasks outside this engine.
