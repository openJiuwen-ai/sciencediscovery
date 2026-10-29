# Which sepsis endotyping signatures cluster together? — Analysis Trace

## 1. Objective

**Question.** Across patients, which sepsis endotyping signatures — the published schemes (Sweeney
inflammopathic/adaptive/coagulopathic, Davenport and Cano SRS, Yao IA/IC/IN, Wong, MARS1–4) and the
bespoke myeloid/lymphoid dysregulation subspace (`mod1`–`mod4`, detrimental/protective/som) — behave as
one coherent axis or as several independent axes, as judged by how their per-patient scores co-vary?

**What success looks like.**
1. A patient-level correlation matrix over all signature scores, computed on a defensible analysis
   population (sepsis patients, one sample per patient, no redundant/derived columns dominating).
2. A partition of the signatures into clusters that is (a) statistically justified (distance metric,
   linkage, number of clusters chosen explicitly), (b) *stable* under patient resampling, and (c) not an
   artefact of one cohort, one distance definition, or deterministic composite columns.
3. A biological/clinical reading of each cluster — which framework's signatures land together, and
   whether each axis is mortality-associated or protective — with the sign conventions of the scores
   established from the data rather than assumed from column names.
4. An explicit statement of what this correlational design cannot establish.

## 2. Data Sources

### `data/subspace_score_table.csv`

| property | value |
|---|---|
| dimensions | 3,948 rows × 69 columns (2.3 MB) |
| unit of observation | one sample (patient × timepoint); 3,218 unique `patient_id`, 3,948 unique `accession` |
| cohorts (`group_id`) | amsterdam 1,071 · acutelines 992 · savemore 755 · qns31079 647 · cchmc 311 · ufl 172 |
| sites (`site`) | 10 (`imx` 28, `stanford` 236, `trinity` 204, `victas` 141, `charles` 38, …) |
| timepoints | `baseline` 3,216; `follow_up_1` 141; `D4` 140; `day 3` 127; `D7` 121; `follow_up_2` 74; `follow_up_3` 57; `follow_up_4` 36; `follow_up_5` 22; `follow_up_6` 8; `follow_up_7` 1; missing 5 |
| `condition` | `infected` 2,892 · missing 705 · `non-infected` 277 · `healthy` 74 |
| `severity` | `severe` 1,798 · `non-severe` 1,293 · missing 780 · `healthy` 77 |
| `d30_mort` | 0 → 2,552 · 1 → 387 · missing 1,009 (so 387/2,939 = 13.2 % 30-day mortality where recorded) |
| `subgroup` | `system-wide` 1,728 · `lymphoid dysregulation` 1,009 · `balanced` 935 · `myeloid dysregulation` 276 |
| `sweeney_endotype` | adaptive 2,088 · inflammopathic 1,017 · coagulopathic 843 |
| `davenport_endotype` | SRS2 1,521 · SRS1 1,352 · SRS3 1,075 |
| `cano_endotype` | SRS2 1,884 · SRS1 1,637 · SRS3 427 |

Source-table composition, QC counts and every derived key number quoted below: [artifact1].

**Score columns used as "signatures" (26 after QC).** Module/subspace: `mod1_score`…`mod4_score`,
`detrimental_score`, `protective_score`, `som_score`; bespoke myeloid/lymphoid:
`myeloid_detrimental_score`, `neutrophil_protective_score`, `monocyte_protective_score`,
`myeloid_protective_score`, `lymphoid_protective_score`, `myeloid_score`; Sweeney:
`inflammopathic_score`, `adaptive_score`, `coagulopathic_score`; Yao: `yao_IA_score`, `yao_IC_score`,
`yao_IN_score`; Wong: `wong_score`; SRS: `davenport_SRSq`, `cano_SRSq`; MARS: `mars1_score`…`mars4_score`.
Example row (first record, `qns31079_954`): `mod1_score` 17.02, `mod2_score` 13.06, `mod3_score` 15.82,
`mod4_score` 16.27, `detrimental_score` 30.08, `protective_score` 32.09, `som_score` 0.937,
`inflammopathic_score` −1.007, `adaptive_score` 0.925, `coagulopathic_score` −0.967, `yao_IA_score` 0.939,
`yao_IC_score` −3.857, `yao_IN_score` 3.214, `wong_score` 4.35, `davenport_SRSq` 0.112, `cano_SRSq` 0.318,
`mars1_score` 1.049, `mars2_score` 0.960, `mars3_score` 0.847, `mars4_score` 0.887.

**Data-quality notes (all verified in Step 1, not assumed).**
* **Repeated measures.** 3,948 samples from 3,218 patients: 2,792 patients contribute 1 sample, 230 → 2,
  147 → 3, 18 → 4, and 30 patients → 5–8 samples. Analysing all rows would pseudo-replicate.
* **Deterministic composites.** Five score columns are exact algebraic functions of others (max |difference|
  ≤ 1.1 × 10⁻⁸): `protective_score = mod3 + mod4`, `detrimental_score = mod1 + mod2`,
  `som_score = detrimental / protective`, `myeloid_score = myeloid_detrimental − myeloid_protective`,
  `lymphoid_score = −lymphoid_protective`. `myeloid_z_score` and `lymphoid_z_score` are z-scaled copies of
  `myeloid_score` / `lymphoid_score` (ρ = ±1.000 exactly, different scale). Left in the primary matrix
  (they are legitimate published-style summaries) but the clustering was re-run without them (Step 9).
* **Probability columns** (`inflammopathic_prob`, `adaptive_prob`, `coagulopathic_prob`, `SRS{1,2,3}_prob`)
  are softmax re-encodings of the same three/four scores (ρ = 0.88 / 0.98 / 0.67 against their own score
  columns) — excluded from the primary matrix to avoid counting one framework twice; reported as a
  sensitivity note.
* **Heavy tails.** `wong_score` is strongly right-skewed (median 16.2, max 1,150.6); several subspace scores
  are on a log-like scale (e.g. `mod1_score` mean 17.61, SD 0.96). This motivates a rank correlation (Step 3).
* **Missingness is structural, not random**: `condition` is missing for the whole acutelines annotation block
  (698 rows) and scattered elsewhere; `sofa` is missing for 3,068/3,948 (78 %), `apache2` for 88 % — severity
  scores are unusable as covariates and were not used.
* **No duplicate `accession`**; `patient_id` is the correct de-duplication key.

## 3. Approach

### Step 1 — Load, QC, and verify the algebraic identities

**Description.** Read the table, tabulate missingness and categorical levels, and test every pair of numeric
columns for exact/algebraic dependence so that derived columns are known before clustering.

**Decision and rationale.** I tested identities numerically (max absolute deviation) instead of trusting
column names, because a "framework" of 69 columns in which half are composites would make the correlation
matrix look artificially modular. Identity checks on the first row alone would have been misleading
(e.g. `protective_score` could have been a weighted sum), so the check is over all 3,948 rows.

```python
import pandas as pd, numpy as np
df = pd.read_csv('data/subspace_score_table.csv')
print(df.shape)                                    # (3948, 69)
print(df.patient_id.nunique(), df.accession.nunique())   # 3218 3948
print(df.isna().sum()[lambda s: s > 0])
print(df.group_id.value_counts())

def maxabs(a, b): return float(np.nanmax(np.abs(np.asarray(a) - np.asarray(b))))
print(maxabs(df.protective_score,  df.mod3_score + df.mod4_score))            # 1.0e-08
print(maxabs(df.detrimental_score, df.mod1_score + df.mod2_score))            # 1.0e-08
print(maxabs(df.som_score,         df.detrimental_score / df.protective_score))  # 8.1e-10
print(maxabs(df.myeloid_score,     df.myeloid_detrimental_score - df.myeloid_protective_score))  # 1.0e-08
print(maxabs(df.lymphoid_score,   -df.lymphoid_protective_score))             # 0.0
```

**Quantitative result.** 3,948 × 69; 3,218 patients; 6 cohorts; 5 exact composites + 2 z-score copies
identified; `condition` missing in 705 rows, `d30_mort` in 1,009, `sofa` in 3,068.

### Step 2 — Define the analysis population

**Description.** Restrict to sepsis patients at their baseline sample, one row per patient.

**Decision and rationale.** The question is about sepsis endotyping, so healthy volunteers (74) and
non-infected hospital controls (277) are out of scope — they would inflate correlations through a
case–control contrast in *every* signature simultaneously and manufacture a "consensus" that is really
just "sick vs not sick". Rows with missing `condition` (705) were *not* dropped silently: they belong to
cohorts whose annotation block is absent (acutelines 698), and they are handled in the sensitivity grid
(Step 8), which shows the matrix is essentially identical with or without every population choice.
Baseline-only + one-row-per-patient avoids pseudo-replication of 732 non-baseline samples and of the 426
patients sampled more than once. Alternative considered and rejected: mixed-effects modelling of repeated
measures — unnecessary, because the sensitivity grid shows follow-up rows change pairwise ρ by ≤ 0.089.

```python
df['is_base'] = df.timepoint.fillna('NA').eq('baseline')
d1 = df[df.condition == 'infected']                     # 2892
d2 = d1[d1.is_base]                                     # 2214
pop = d2.sort_values('patient_id').drop_duplicates('patient_id', keep='first')   # 2203
D = pop[SIG].astype(float)
```

**Quantitative result.** 3,948 → 2,892 (infected) → 2,214 (baseline) → **2,203 patients** (11 patients had
two baseline samples; first kept). 1,917 of them have `d30_mort` recorded.

### Step 3 — Correlation matrix: Spearman primary, Pearson and within-cohort-z as controls

**Description.** Compute the 26 × 26 pairwise correlation matrix of signature scores across the 2,203
patients.

**Decision and rationale.** **Spearman** was chosen as primary because (i) `wong_score` has a 70-fold
range with a heavy right tail, (ii) the subspace scores are on log-like scales, and (iii) the scores come
from different frameworks (z-scores, SRSq probabilities, module log-expression) whose monotone
transformations differ — rank correlation is invariant to any monotone recalibration, so it compares
*ordering of patients*, which is what "signature agreement" means here. Pearson was retained as a control
(agreement over 325 pairs: r = 0.992). A third matrix was computed after **within-cohort z-scoring**
(each signature standardised inside each `group_id`, then pooled) to remove cohort mean/scale shifts — the
strongest possible batch correction without discarding cohorts; agreement with the primary matrix r = 0.951.
Alternatives rejected: partial correlation adjusting for severity (SOFA is 78 % missing — impossible);
correlating on residuals of a severity model (circular, since the scores *are* severity proxies).

```python
R  = D.corr(method='spearman')
Rp = D.corr(method='pearson')
Zb = df[(df.condition == 'infected') & df.is_base].sort_values('patient_id').drop_duplicates('patient_id').copy()
Zb[SIG] = Zb.groupby('group_id')[SIG].transform(lambda s: (s - s.mean()) / s.std(ddof=0))
Rz = Zb[SIG].astype(float).corr(method='pearson')
iu = np.triu_indices_from(R, 1)
print(np.abs(R.values[iu]).mean())                                  # 0.476
print(np.corrcoef(R.values[iu], Rp.values[iu])[0, 1])               # 0.9922
print(np.corrcoef(R.values[iu], Rz.values[iu])[0, 1])               # 0.9507
```

**Quantitative result.** Mean |ρ| = 0.476, median ρ = 0.149 (IQR −0.436 to +0.512), 43.7 % of the 325 pairs
negative, max |ρ| = 0.960. 154 pairs (47.4 %) at |ρ| ≥ 0.5, 110 (33.8 %) ≥ 0.6, 79 (24.3 %) ≥ 0.7, 42
(12.9 %) ≥ 0.8. A near-balanced positive/negative split is itself evidence for a **bipolar** structure
rather than a single "dysregulation" gradient.

### Step 4 — Hierarchical clustering of signatures

**Description.** Cluster the 26 signatures from the distance matrix `1 − ρ` with average linkage; inspect
cophenetic correlation, merge heights and silhouette over k = 2…8.

**Decision and rationale.** **Signed** distance `1 − ρ` rather than `1 − |ρ|`: anti-correlated signatures
(e.g. `inflammopathic` vs `adaptive`, ρ = −0.85) are biologically *opposite*, not similar; folding the sign
would merge the two poles of the main axis into one cluster and destroy the very structure being asked
about. This is an empirical choice, verified in Step 9 (signed distance gives silhouette 0.513 vs 0.395 for
`1 − |ρ|`, and the two partitions differ, ARI 0.41). **Average linkage** was chosen over Ward because Ward
assumes Euclidean geometry and tends to produce equal-sized spherical clusters, whereas correlation-distance
modules are chain-like; complete and Ward were run as controls (ARI 0.88 with the chosen partition).
Cophenetic correlation 0.805 confirms the dendrogram represents the distance matrix faithfully.

```python
from scipy.cluster.hierarchy import linkage, fcluster, cophenet
from scipy.spatial.distance import squareform
from sklearn.metrics import silhouette_score
dist = 1 - R.values; np.fill_diagonal(dist, 0); dist = (dist + dist.T) / 2
cond = squareform(dist, checks=False)
Za = linkage(cond, method='average')
print(cophenet(Za, cond)[0])                                        # 0.805
print({k: silhouette_score(dist, fcluster(Za, k, criterion='maxclust'), metric='precomputed')
       for k in range(2, 9)})
print(np.round(Za[-8:, 2], 3))                                      # merge heights
```

**Quantitative result.** Cophenetic r = 0.805. Silhouette: k=2 **0.536**, k=3 0.510, k=4 0.513, k=5 0.526,
k=6 0.450, k=7 0.385, k=8 0.435. Last merge heights: 0.422, 0.442, 0.515, 0.542, 0.627, 0.811, 0.960,
**1.307** — i.e. one dominant split (the 2-cluster solution) and a secondary plateau around 0.55–0.63.

### Step 5 — Choose k by bootstrap stability, not by silhouette alone

**Description.** Resample the 2,203 patients with replacement 1,000 times, re-cluster each resample, and
score how often each reference cluster is recovered (mean Jaccard per cluster) plus the co-clustering
frequency of every signature pair.

**Decision and rationale.** Silhouette cannot distinguish k = 2 (0.536) from k = 4 (0.513) or k = 5 (0.526);
it rewards coarse cuts on a bipolar matrix. Stability is the more relevant criterion for a descriptive
claim ("these signatures belong together"), so k was chosen where the partition is most reproducible.
k = 4 wins decisively (Jaccard 0.966, SD 0.095) and is also the level at which each cluster has a distinct
biological identity; k = 2 is reported as the coarser (and statistically strongest) two-tier solution.
Alternatives considered: gap statistic (not used — no reference null distribution for a correlation matrix
of non-independent, partly derived features); elbow on merge height (used as a cross-check, consistent with
a cut between 0.63 and 0.81, i.e. k = 2–3).

```python
rng = np.random.default_rng(20241029)
B, K = 1000, 4
co = np.zeros((len(SIG), len(SIG))); jac = {k: [] for k in range(2, 7)}
for b in range(B):
    idx = rng.integers(0, n_pop, n_pop)
    Rb = D.iloc[idx].corr(method='spearman').values
    db = 1 - Rb; np.fill_diagonal(db, 0); db = (db + db.T) / 2
    zb = linkage(squareform(db, checks=False), method='average')
    co += (fcluster(zb, K, criterion='maxclust')[:, None] == fcluster(zb, K, criterion='maxclust')[None, :])
    for k in jac:
        lk = fcluster(zb, k, criterion='maxclust'); lr = fcluster(Za, k, criterion='maxclust')
        for c in np.unique(lr):
            A = set(np.where(lr == c)[0]); Bs = set(np.where(lk == lk[min(A)])[0])
            jac[k].append(len(A & Bs) / len(A | Bs))
co /= B
```

**Quantitative result.** Mean Jaccard: k=2 0.765 (SD 0.295), k=3 0.902 (0.199), **k=4 0.966 (0.095)**,
k=5 0.905 (0.246), k=6 0.874 (0.281). k = 4 adopted as the primary partition.

### Step 6 — Orient the axes from the data, then name clusters

**Description.** Eigen-decompose the correlation matrix; orient PC1 so that it is positive for
`inflammopathic_score` (the canonical inflammatory marker), and label clusters 1…k by descending mean PC1
loading.

**Decision and rationale.** Score orientation cannot be assumed from names in this integration: `yao_IA`
behaves like an *adaptive/lymphoid* signature (ρ = +0.88 with `adaptive_score`, −0.79 with
`inflammopathic_score`, mortality AUC 0.34), while `yao_IN` behaves like an inflammatory one (ρ = +0.60 with
`inflammopathic_score`). Rather than guess which paper's sign convention each column follows, all labels
are assigned from the empirical loading and cross-checked against 30-day mortality (Step 7). This is why the
cluster numbering is interpretable: cluster 1 = most inflammatory, cluster 4 = most adaptive/lymphoid.

```python
vals, vecs = np.linalg.eigh(R.values)
o = np.argsort(vals)[::-1]; vals, vecs = vals[o], vecs[:, o]
expl = vals / len(SIG); load = vecs[:, :4] * np.sqrt(vals[:4])
if load[SIG.index('inflammopathic_score'), 0] < 0: load[:, 0] *= -1
if load[SIG.index('lymphoid_protective_score'), 1] > 0: load[:, 1] *= -1
print(np.round(expl[:6] * 100, 1))     # [52.2 17.7  8.2  5.2  3.5  2.6]
```

**Quantitative result.** Eigenvalues 13.57, 4.59, 2.13, 1.34, 0.92, 0.68 → **PC1 = 52.2 %**, PC2 = 17.7 %,
PC1+PC2 = 69.8 % of total variance (mean eigenvalue 1.0, so PC1 is 13.6× the null expectation).

### Step 7 — Clinical anchoring of each cluster

**Description.** For every signature, and for each cluster's mean z-score, compute the rank-based AUC for
30-day mortality (n = 1,917 with outcome), with 1,000-sample bootstrap CIs for the cluster scores.

**Decision and rationale.** A cluster of co-varying signatures is only meaningful if the axis it defines is
clinically oriented; mortality AUC gives an assumption-free orientation check and shows that clusters 1 and
4 are not merely "the same axis, twice". AUC (Mann–Whitney) was used instead of a logistic model because
`d30_mort` is complete in only 1,917/2,203 patients and the AUC needs no covariate specification.

```python
from scipy.stats import mannwhitneyu
def auc(x, y):
    m = ~pd.isna(x) & ~pd.isna(y); x, y = np.asarray(x)[m], np.asarray(y)[m]
    u = mannwhitneyu(x[y == 1], x[y == 0], alternative='two-sided')
    return u.statistic / ((y == 1).sum() * (y == 0).sum()), int(m.sum())
zD = (D - D.mean()) / D.std(ddof=0)
clu_score = pd.DataFrame({c: zD[[SIG[i] for i in np.where(lab == c)[0]]].mean(1)
                          for c in sorted(set(lab))}, index=D.index)
```

**Quantitative result.** Cluster-score AUCs: C1 **0.658** (95 % CI 0.619–0.692), C2 0.551 (0.506–0.593),
C3 0.503 (0.462–0.542), C4 **0.345** (0.309–0.383). Individual signatures span 0.341
(`yao_IA_score`) to 0.656 (`inflammopathic_score`) — see `out/mortality_auc.csv`.

### Step 8 — Sensitivity to population definition

**Description.** Recompute the matrix on four alternative populations and compare all 325 pair correlations
with the primary matrix.

**Decision and rationale.** The population choice (sepsis-only, baseline-only, one row per patient) is the
largest judgement call in the analysis, so it must be shown not to drive the result.

```python
pops = {'infected_baseline_1perpatient': D,
        'infected_all_rows': df[df.condition == 'infected'][SIG].astype(float),
        'all_baseline_1perpatient': df[df.is_base].sort_values('patient_id').drop_duplicates('patient_id')[SIG].astype(float),
        'all_rows_incl_healthy': df[SIG].astype(float)}
for k, X in pops.items():
    v = X.corr(method='spearman').values[iu]
    print(k, len(X), np.abs(v).mean(), np.corrcoef(v, R.values[iu])[0, 1], np.abs(v - R.values[iu]).max())
```

**Quantitative result.** Agreement with the primary matrix: infected-all-rows (n = 2,892) r = 0.998,
max Δρ 0.089; all-baseline (n = 3,199) r = 0.998, max Δρ 0.111; all-rows-including-healthy (n = 3,948)
r = 0.998, max Δρ 0.124. Mean |ρ| stays 0.452–0.476. **No population choice changes the structure.**

### Step 9 — Sensitivity to distance, linkage, and composite columns

**Description.** Re-cluster with `1 − |ρ|`, with complete/Ward/single linkage, and on a reduced set of 22
"primitive" signatures after removing all deterministic composites.

**Decision and rationale.** Two failure modes had to be excluded: (i) the partition is an artefact of one
metric/linkage rule; (ii) the partition is produced by the derived columns (`som`, `myeloid_score`,
`detrimental`, `protective`, `lymphoid_score`) that are algebraically tied to `mod1`–`mod4` and the
myeloid/lymphoid subscores.

```python
from sklearn.metrics import adjusted_rand_score
for dname, Dm in [('1-r', 1 - R), ('1-|r|', 1 - np.abs(R))]:
    Dm = Dm.copy(); np.fill_diagonal(Dm, 0); Dm = (Dm + Dm.T) / 2
    for meth in ('average', 'complete', 'ward', 'single'):
        lab_k = fcluster(linkage(squareform(Dm, checks=False), method=meth), 4, criterion='maxclust')
        print(dname, meth, adjusted_rand_score(ref_mem, lab_k))
```

**Quantitative result.** Against the primary k = 4 partition: complete linkage 1−ρ ARI **0.882**; Ward 1−ρ
0.882; single linkage 0.665; `1 − |ρ|` average 0.406 (silhouette 0.395 vs 0.513 — the unsigned metric fits
worse). Removing the 5 composites and re-clustering the 22 primitives gives an **identical partition
(ARI = 1.000)**: C1 = mod1, mod2, myeloid_detrimental, inflammopathic, coagulopathic, yao_IN, wong,
davenport_SRSq, cano_SRSq, mars2; C2 = yao_IC, mars1; C3 = mod3, neutrophil_protective,
monocyte_protective, myeloid_protective, mars4; C4 = mod4, lymphoid_protective, adaptive, yao_IA, mars3.

### Step 10 — Cross-cohort replication and graph-community cross-check

**Description.** Compute the correlation matrix inside each cohort, correlate its 325 pair values with the
pooled matrix (Mantel-type test with 500 permutations of the 26 variable labels), and compare the
hierarchical partition with greedy-modularity communities of the |ρ| ≥ 0.5/0.6/0.7 graph.

**Decision and rationale.** "Across patients" must mean across *cohorts*, otherwise a single site's batch
effect could produce the whole pattern. The Mantel null must permute **variables** (patients are
exchangeable for a correlation matrix, so permuting rows is a no-op — an earlier version of this code did
exactly that and returned p = 1.0 for every cohort; the bug is documented here because it is the kind of
mistake that silently inflates confidence). Graph communities are reported as an independent, non-hierarchical
view, with ARI quantifying agreement.

```python
for c in df.group_id.unique():
    d = df[(df.group_id == c) & (df.condition == 'infected') & df.is_base] \
          .sort_values('patient_id').drop_duplicates('patient_id')
    Rc = d[SIG].astype(float).corr(method='spearman').values
    v = np.array([Rc[SIG.index(a), SIG.index(b)] for a, b in pairs])
    obs = np.corrcoef(v, R.values[iu])[0, 1]
    null = []
    for _ in range(500):
        p = rng.permutation(len(SIG)); Rp_ = Rc[p][:, p]          # permute VARIABLES, not patients
        null.append(np.corrcoef([Rp_[SIG.index(a), SIG.index(b)] for a, b in pairs], R.values[iu])[0, 1])
    print(c, len(d), obs, (np.sum(np.array(null) >= obs) + 1) / 501)

import networkx as nx
A = (np.abs(R.values) >= 0.6).astype(float); np.fill_diagonal(A, 0)
comms = list(nx.algorithms.community.greedy_modularity_communities(nx.from_numpy_array(A)))
```

**Quantitative result.** Mantel r: amsterdam 0.967 (n = 757), acutelines 0.925 (209), cchmc 0.923 (108),
qns31079 0.885 (539), ufl 0.769 (101), savemore 0.752 (489); all p = 0.002 (the minimum attainable with
500 permutations). Pairwise sign agreement with the pooled matrix 78–93 %; among pairs with |ρ| ≥ 0.5,
**92.9 %** keep the same sign in all four large cohorts. Graph communities: 4 communities at |ρ| ≥ 0.5
(154 edges), 5 at 0.6 (110 edges), 7 at 0.7 (79 edges); ARI vs the hierarchical k = 4 partition 0.13 / 0.26 /
0.43 — the graph view splits the two large clusters into sub-modules at high thresholds (expected: a
threshold graph fragments dense blocks), but never merges clusters 1 and 4.

## 4. Results

### 4.1 The correlation structure is one dominant bipolar axis plus two orthogonal modules

PC1 explains **52.2 %** of the variance of the 26-signature correlation matrix (eigenvalue 13.57 vs mean
1.0) and PC2 another **17.7 %**; PC1+PC2 = 69.8 %. PC1 is a single axis running from the
myeloid/inflammatory pole to the lymphoid/adaptive pole: the loadings are highest for `inflammopathic`,
`myeloid_score`, `myeloid_detrimental`, `detrimental`, `som`, `davenport_SRSq`, `cano_SRSq` at one end and
`adaptive`, `lymphoid_protective`, `yao_IA`, `mod4`, `protective`, `mars3` at the other. Consistent with this,
43.7 % of all 325 pairs are negative, and the extreme pairs are strongly negative:
`lymphoid_protective` vs `cano_SRSq` ρ = −0.879, `som` vs `adaptive` ρ = −0.878, `adaptive` vs `mars2`
ρ = −0.863, `inflammopathic` vs `adaptive` ρ = −0.849. Full matrix: [artifact6]; loadings: [artifact7].

### 4.2 Four stable clusters (bootstrap Jaccard 0.966)

| cluster | n | members | mean ρ within | mean ρ to other clusters | mean 30-d AUC | cluster-score AUC (95 % CI) |
|---|---|---|---|---|---|---|
| **C1 Myeloid / inflammatory-dominant** | 13 | `mod1`, `mod2`, `detrimental`, `som`, `myeloid_detrimental`, `myeloid`, `inflammopathic`, `coagulopathic`, `yao_IN`, `wong`, `davenport_SRSq`, `cano_SRSq`, `mars2` | 0.626 | −0.226 | 0.627 | **0.658** (0.619–0.692) |
| **C2 MARS1–Yao-IC axis** | 2 | `yao_IC`, `mars1` | 0.737 | −0.056 | 0.548 | 0.551 (0.506–0.593) |
| **C3 Monocyte/myeloid-protective (mod3) module** | 5 | `mod3`, `neutrophil_protective`, `monocyte_protective`, `myeloid_protective`, `mars4` | 0.477 | +0.036 | 0.496 | 0.503 (0.462–0.542) |
| **C4 Lymphoid / adaptive-protective** | 6 | `mod4`, `protective`, `lymphoid_protective`, `adaptive`, `yao_IA`, `mars3` | 0.805 | −0.434 | 0.357 | **0.345** (0.309–0.383) |

Membership table: [artifact2]; clustered heatmap with dendrogram: [artifact3]; per-cluster statistics: [artifact4]; bootstrap stability: [artifact5].

Cluster-centroid correlations: **C1–C4 = −0.85**, C2–C3 = −0.56, C2–C4 = −0.36, C1–C2 = +0.26, C1–C3 =
+0.09, C3–C4 = +0.06. So C1 and C4 are two ends of the main axis, while C2 and C3 are two ends of a second,
largely orthogonal axis (PC2) — not severity duplicates.

**Coarser tier (k = 2, silhouette 0.536).** 15 vs 11 signatures: the C1-type pole (mod1, mod2, detrimental,
som, myeloid_detrimental, myeloid, inflammopathic, coagulopathic, yao_IC, yao_IN, wong, davenport, cano,
mars1, mars2) against the C3+C4 pole (mod3, mod4, protective, neutrophil/monocyte/myeloid/lymphoid
"protective" scores, adaptive, yao_IA, mars3, mars4). At k = 3 the monocyte/myeloid-protective module (C3)
separates out; at k = 5, `mod3`+`mars4` split from the three myeloid "protective" subscores — the
hierarchy is C1 | C2 | C3 | C4 with C3 internally loose (within-ρ 0.477).

### 4.3 Which published frameworks land together

* **Sweeney inflammopathic ↔ SRS1 ↔ bespoke myeloid axis.** `inflammopathic_score` clusters with
  `davenport_SRSq` (ρ = 0.75), `cano_SRSq` (0.74), `myeloid_detrimental` (0.81), `myeloid_score` (0.82) and
  `detrimental` (0.75); all are in C1 and all are mortality-detrimental (AUC 0.64–0.66). `coagulopathic`
  is also in C1 but is the weakest member (ρ = 0.48–0.53 to the core; AUC 0.599), i.e. a mild
  inflammatory-coagulopathic variant rather than an independent axis in this integration.
* **Sweeney adaptive ↔ Yao IA ↔ MARS3 ↔ the "protective"/lymphoid subspace.** `adaptive_score` and
  `yao_IA_score` correlate 0.876; both with `lymphoid_protective` (0.82 / 0.87) and `mod4` (0.78 / 0.82);
  `mars3` joins at 0.78 / 0.80. This whole cluster is *protective* for 30-day mortality (AUC 0.34–0.39) —
  the lymphoid/adaptive pole.
* **Davenport and Cano SRS are the same instrument.** `davenport_SRSq` vs `cano_SRSq` ρ = **0.928**, and
  their label assignments agree in 75.8 % of patients (Cramér's V 0.62) — they must not be treated as
  independent evidence in a meta-analysis. Sweeney vs Davenport label agreement is only 57.4 %
  (V = 0.48): both `inflammopathic` (460/638) and `coagulopathic` (231/414) patients are mostly called
  SRS1, i.e. the two frameworks disagree at the label level even though their continuous scores correlate.
* **MARS splits.** `mars2` behaves as an inflammatory/myeloid signature (ρ = 0.73 with `inflammopathic`,
  −0.86 with `adaptive`; AUC 0.631), `mars3` as an adaptive/lymphoid signature (AUC 0.366), but `mars1`
  and `mars4` do **not** follow either pole: `mars1` pairs with `yao_IC` (ρ = 0.74, C2; AUC 0.579) and
  `mars4` with the mod3/monocyte-protective module (C3; AUC 0.591). MARS1–4 is therefore not one axis.
* **The bespoke subspace decomposes onto the published frameworks.** `mod1`+`mod2` = `detrimental`
  (myeloid/inflammatory, C1), `mod4` = lymphoid/adaptive (C4, ρ = 0.96 with `lymphoid_protective`),
  `mod3` = the monocyte/myeloid-protective module (C3, ρ = 0.57 with `monocyte_protective`, −0.59 with
  `yao_IC`). `protective_score` is the sum `mod3 + mod4` and therefore sits between C3 and C4 (ρ = 0.88
  with mod4, 0.70 with mod3) — a composite, not an independent axis.
* **Wong** behaves as a weak inflammatory marker (ρ = 0.71 with `mod1`, 0.62 with `neutrophil_protective`;
  AUC 0.548) and is a peripheral member of C1.

### 4.4 Reproducibility

The partition survives: (i) all four population definitions (pairwise ρ agreement ≥ 0.998); (ii) complete
linkage and Ward (ARI 0.88); (iii) removal of all deterministic composites (ARI 1.000); (iv) 1,000 patient
bootstrap resamples (Jaccard 0.966); (v) all six cohorts separately (Mantel r 0.75–0.97, p = 0.002, 92.9 %
sign concordance among |ρ| ≥ 0.5 pairs). It does **not** survive replacing the signed distance with
`1 − |ρ|` (ARI 0.41), which is expected and is the main modelling assumption: anti-correlated signatures
are treated as opposite, not as similar. Stability table: [artifact5]; per-cohort Mantel results: [artifact9]; replication scatter: [artifact10]; distance/linkage sensitivity grid: [artifact11].

### 4.5 Interpretation

The four clusters reproduce, in one patient-level integration, the two-arm structure that the individual
sepsis-endotyping literatures describe separately: a **myeloid-dominant, hyper-inflammatory/coagulopathic
arm** (Sweeney inflammopathic, SRS1, MARS2, Yao IN, the `mod1`/`mod2` → detrimental subspace) that carries
the excess 30-day mortality (AUC 0.66), and a **lymphoid/adaptive arm** (Sweeney adaptive, Yao IA, MARS3,
`mod4`, lymphoid-protective) that is associated with survival (AUC 0.35). The anti-correlation between these
arms (ρ ≈ −0.85) is the single strongest feature of the data and is what makes the published schemes
"consensus" at the score level even where their categorical labels disagree.

Two additional axes are not reducible to that gradient: a **MARS1/Yao-IC axis** (PC2 positive end,
ρ = −0.56 to the next module, mortality-neutral at AUC 0.55) and a **monocyte/myeloid-protective `mod3`
module** (PC2 negative end, AUC 0.50). Their near-zero correlation with PC1 (0.09 and 0.05 mean loading)
means they carry information a single "inflammation score" would miss — relevant to any claim that sepsis
immunodysregulation is one-dimensional. Per-signature and per-cluster mortality AUCs: [artifact8].

### 4.6 What this analysis cannot conclude

* **Correlation is not mechanism.** Co-varying scores can reflect a shared upstream driver (severity,
  circulating leukocyte composition, RNA-quality/batch), not a shared pathway. No causal or pathway claim is
  made, and no gene-level evidence was used (the 104-gene matrix was not part of this task's inputs).
* **Scores are not independent measurements.** Many are functions of the same 104 genes and, within the
  bespoke framework, exact algebraic composites of each other; the effective number of independent
  signatures is well below 26, so the "4 clusters" are a description of *score geometry*, not of 4
  independent biological processes.
* **Sign/orientation of the Yao and Wong columns is inferred, not verified.** I did not consult the source
  publications (prohibited by the task), so `yao_IA/IC/IN` and `wong_score` are treated as opaque
  identifiers whose meaning is read off their empirical correlations and mortality association.
* **Mortality is only recorded for 1,917/2,203 patients** and the missingness is cohort-structured, so the
  AUCs are descriptive and may be biased if outcome ascertainment differs by cohort.
* **No adjustment for severity, age, sex, or treatment** was possible (SOFA missing 78 %, Apache 88 %), so
  "detrimental vs protective" is unadjusted association.
* **Cluster boundaries are descriptive.** The k = 4 cut is the most stable, but k = 2 and k = 5 are also
  defensible; cluster membership of peripheral members (`wong`, `coagulopathic`, `mars4`, `mod3`) should be
  read as "closest to", not as categorical.

## 5. References

**Endotyping frameworks.**
1. Sweeney TE, Perumal TM, Henao R, et al. A community approach to mortality prediction in sepsis via gene expression analysis. *Nat Commun.* 2018;9(1):694. doi:10.1038/s41467-018-03078-2. PMID: 29449546. (inflammopathic / adaptive / coagulopathic endotypes)
2. Davenport EE, Burnham KL, Radhakrishnan J, et al. Genomic landscape of the individual host response and outcomes in sepsis: a prospective cohort study. *Lancet Respir Med.* 2016;4(4):259–271. doi:10.1016/S2213-2600(16)00046-1. PMID: 26917434. (SRS1–3)
3. Burnham KL, Davenport EE, Radhakrishnan J, et al. Shared and distinct aspects of the sepsis transcriptomic response to fecal peritonitis and pneumonia. *Am J Respir Crit Care Med.* 2017;196(3):328–339. doi:10.1164/rccm.201608-1685OC. (SRS1 = immunosuppressed / endotoxin-tolerant phenotype)
4. Scicluna BP, van Vught LA, Zwinderman AH, et al. Classification of patients with sepsis according to blood genomic endotype: a prospective cohort study. *Lancet Respir Med.* 2017;5(10):816–826. doi:10.1016/S2213-2600(17)30294-1. PMID: 28864056. (MARS1–4)
5. Baghela A, Pena OM, Lee AH, et al. Predicting sepsis severity at first clinical presentation: the role of endotypes and mechanistic signatures. *EBioMedicine.* 2022;75:103776. doi:10.1016/j.ebiom.2021.103776. (independent validation of MARS endotypes in sepsis)
6. Seymour CW, Kennedy JN, Wang S, et al. Derivation, validation, and potential treatment implications of novel clinical phenotypes for sepsis. *JAMA.* 2019;321(20):2003–2017. doi:10.1001/jama.2019.5791. (clinical phenotypes α/β/γ/δ; precedent that sepsis subphenotypes are few and severity-ordered)
7. Wong HR, Salisbury S, Xiao Q, et al. The pediatric sepsis biomarker risk model. *Crit Care.* 2012;16(5):R174. doi:10.1186/cc11652. (Wong-lab PERSEVERE transcriptomic risk modelling; the `wong_score` column is treated as an opaque scalar in this release)

**Immunology invoked in interpretation.**
8. Hotchkiss RS, Monneret G, Payen D. Sepsis-induced immunosuppression: from cellular dysfunctions to immunotherapy. *Nat Rev Immunol.* 2013;13(12):862–874. doi:10.1038/nri3552. (lymphoid depletion / immunoparalysis arm)
9. Venet F, Monneret G. Advances in the understanding and treatment of sepsis-induced immunosuppression. *Nat Rev Nephrol.* 2018;14(2):121–137. doi:10.1038/nrneph.2017.165.

**Methods.**
10. Spearman C. The proof and measurement of association between two things. *Am J Psychol.* 1904;15(1):72–101. (rank correlation)
11. Fisher RA. On the "probable error" of a coefficient of correlation deduced from a small sample. *Metron.* 1921;1:3–32. (Fisher z CI used for the pair CIs)
12. Sokal RR, Rohlf FJ. The comparison of dendrograms by objective methods. *Taxon.* 1962;11(2):33–40. (cophenetic correlation)
13. Ward JH. Hierarchical grouping to optimize an objective function. *J Am Stat Assoc.* 1963;58(301):236–244.
14. Rousseeuw PJ. Silhouettes: a graphical aid to the interpretation and validation of cluster analysis. *J Comput Appl Math.* 1987;20:53–65.
15. Hubert L, Arabie P. Comparing partitions. *J Classification.* 1985;2:193–218. (adjusted Rand index)
16. Mantel N. The detection of disease clustering and a generalized regression approach. *Cancer Res.* 1967;27(2):209–220. (matrix-correlation test)
17. Efron B. Bootstrap methods: another look at the jackknife. *Ann Stat.* 1979;7(1):1–26.
18. Clauset A, Newman MEJ, Moore C. Finding community structure in very large networks. *Phys Rev E.* 2004;70:066111. (greedy modularity)
19. Hanley JA, McNeil BJ. The meaning and use of the area under a receiver operating characteristic (ROC) curve. *Radiology.* 1982;143(1):29–36.

**Software.** Python 3.14 with pandas 3.1.0, NumPy 2.5.4, SciPy 1.18.1, scikit-learn 1.9.1, NetworkX,
Matplotlib (pandas/scipy/sklearn versions as installed in the analysis sandbox). Scripts:
`scripts/01_inspect.py`, `02_explore.py`, `03_corr_explore.py`, `11_pipeline_final.py`,
`12_addendum.py`, `13_method_sensitivity.py`, `14_composite_check.py`; tables and figures in `out/`.
