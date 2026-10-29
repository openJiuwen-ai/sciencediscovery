# Analysis Trace — Proteins associated with body composition (percent fat and breast volume) during feminizing GAHT

## 1. Objective

**Question.** Which plasma proteins correlate with changes in body composition — specifically **percent body fat** and **breast volume** — following feminizing gender-affirming hormone therapy (GAHT)?

**Operational definition of the question in this dataset.** The supplied table is a set of pre-computed, per-protein results from a mixed linear model in which the *body-composition variable is the predictor* and *protein level (NPX) is the outcome*:

```
NPX_protein ~ body_composition_variable + age + baseline_BMI + (1 | participant_ID)
```

with a random intercept per participant (i.e., a within-person/`change` contrast, blended with between-person information) fitted separately for each of the two body-composition variables and each protein. Therefore "correlates with changes in body composition" is operationalised here as **a non-zero adjusted mixed-model slope (`estimate`) between the body-composition measure and the protein level, declared significant at Benjamini–Hochberg FDR < 0.05**, separately for percent fat and for breast volume, plus the direction of that slope.

**What success looks like.**
1. A defensible, reproducible significance call per trait (FDR-controlled, not raw p), with explicit counts at every filtering step.
2. A named, quantified list of the proteins that track percent fat, the proteins that track breast volume, and — most importantly — the **shared** proteins, with effect sizes and adjusted p-values.
3. A statement of direction (does the protein rise or fall with the trait), because direction is what carries biological meaning here.
4. A mechanistic interpretation that is checked against internal evidence in the table (e.g., positive control proteins such as leptin; treatment-axis markers such as INSL3 and prolactin) rather than asserted from memory.
5. An explicit account of what these data *cannot* establish (no causal direction, no separation of within- vs between-person effects, no separation of body-composition effects from treatment-exposure effects).

---

## 2. Data Sources

### `data/41591_2025_4023_MOESM2_ESM(Supplementary Table 4).csv`

| property | value |
|---|---|
| Physical rows in file | 5,282 |
| Non-data rows | 4 (row 1 = model title, row 2 = model description, row 3 = blank, row 4 = column header) |
| **Protein records parsed** | **5,278** (one row per protein, `protein_id` = HGNC gene symbol) |
| Columns | 5 |
| Missing values | 0 in every column |
| Duplicated `protein_id` | 0 |
| Non-numeric values in numeric columns | 0 |

Row 1 (title, verbatim): `*Model: Percentage Fat or Breast Volume associated Olink proteins`
Row 2 (model description, verbatim): `*Mixed linear model with percentage fat or breast volume as  predictor. Random intercept included for participant ID, adjusted for age and baseline BMI.`

**Key columns**

| column | meaning | example values |
|---|---|---|
| `protein_id` | HGNC symbol of the Olink target | `CA6`, `LEP`, `PLB1`, `INSL3`, `PRL` |
| `estimate_Percent_Fat` | mixed-model slope: change in protein NPX per **+1 percentage point** body fat | `-0.139327703` (CA6), `+0.196169604` (LEP) |
| `adj.p.value_Percent_Fat` | multiple-testing-adjusted p for that slope | `0.000545696`, `0.999695091` |
| `estimate_Breast_Volume` | mixed-model slope: change in protein NPX per **+1 unit** breast volume (unit not stated in the file) | `-0.003366566` (CA6), `+0.00527293` (LEP) |
| `adj.p.value_Breast_Volume` | adjusted p for that slope | `0.000846422`, `0.639016289` |

**Platform / cohort context (from the task specification, not from the file).** Olink Explore HT plasma proteomics (~5.4k proteins), feminizing GAHT cohort with two antiandrogen arms (cyproterone acetate, spironolactone), baseline and 6-month samples, plus a pregnancy comparator arm. The file itself contains no sample-level data, no arm labels, no group sizes and no protein abundance values — only the 5,278 fitted per-protein results.

**Data-quality notes / checks actually performed**

* *Is `adj.p.value` really adjusted?* Yes, and this is verifiable from the file itself. If the column were raw p, Benjamini–Hochberg applied to it would leave **0** proteins at FDR<0.05 for either trait (recomputed: 0 and 0). The reported columns give 38 and 249 proteins below 0.05, with the 38th smallest fat value at 0.047 — a pattern that is only self-consistent if the values are already adjusted (BH-adjusted p is non-decreasing in the raw-p rank and is bounded below by raw p). Conclusion: treat `adj.p.value_*` as the FDR-adjusted p and **do not** re-adjust.
* *Ties.* Three proteins share the minimum fat adjusted p (`0.000545696`: CA6, LEP, PLB1), which is the signature of a BH step-down procedure at the same rank block.
* *No `NA`s, no duplicate symbols, no text in numeric fields* → no imputation, filtering or de-duplication was required (5,278 → 5,278).
* *Absent proteins that one might expect.* `ADIPOQ` (adiponectin), `IGF1`, `IGF2`, `PLIN2`, `CGA`, `CRP`, `SAA1`, `OPG`/`TNFRSF11B` is present but `OPG` alias was not used — i.e. the panel does not contain every classical adipokine. This matters for interpretation: absence of adiponectin from the results is a **panel** fact, not a biological negative.

---

## 3. Approach

All analysis was run in Python 3.14 with pandas 3.1.0 / numpy 2.5.4 / scipy 1.18.1 / matplotlib 3.11.2, installed into a workspace-local `pylibs/` directory (`pip3 install --target=./pylibs pandas numpy scipy matplotlib`, invoked with `PYTHONPATH=./pylibs`). Full script: `analyze_bodycomp.py`; auxiliary checks: `followup_checks.py`, `cat_by_trait.py`; console logs: `output/analysis_log.txt`, `output/followup_log.txt`, `output/cat_by_trait_log.txt`.

### Step 1 — Parse the file with the correct header row

**Description.** Read the CSV with no header to inspect its shape, then re-read it with `header=3` (0-based), which is the real column-header row (rows 1–2 are titles, row 3 is blank), and rename the columns to short, analysis-friendly names.

**Decision and rationale.** The task note says "use row 2 as the header", but the file actually has **two** title lines and a blank line before the header (verified by printing the first five raw rows). Parsing at row 2 would have produced a one-column frame of title text; parsing at `header=3` yields the 5 real columns. I verified the column names before renaming, so no column was silently mis-assigned. Alternative considered and rejected: `skiprows=[0,1,2]` with `header=None` — equivalent, but `header=3` keeps the names auditable.

```python
PATH = 'data/41591_2025_4023_MOESM2_ESM(Supplementary Table 4).csv'
raw = pd.read_csv(PATH, header=None, dtype=str, keep_default_na=False)
print('[load] raw shape (rows, cols):', raw.shape)          # (5282, 5)
print('[load] title row 1:', raw.iloc[0, 0])
print('[load] title row 2:', raw.iloc[1, 0][:160])
print('[load] row 3 blank?', (raw.iloc[2].str.strip() == '').all())   # True

df = pd.read_csv(PATH, header=3)
df.columns = ['protein_id', 'est_fat', 'padj_fat', 'est_breast', 'padj_breast']
print('[load] parsed shape:', df.shape)                      # (5278, 5)
```

**Quantitative result.** 5,282 physical rows → 5,278 protein records × 5 columns; header correctly identified at row 4.

### Step 2 — QC: completeness, duplicates, type coercion, and the "already adjusted?" check

**Description.** Count duplicates, count `NA`s, force numeric coercion and count coercion failures, drop incomplete rows, then test whether the `adj.p.value` columns behave like already-adjusted p-values by re-running BH on them.

**Decision and rationale.** Dropping rows with missing estimates/p-values is the conservative choice (a missing p cannot be called significant). No rows needed dropping, so the decision is moot in practice but was applied anyway so the code is safe. The "already adjusted?" test is important: if I treated an already-adjusted column as raw and applied BH again, I would be **over-conservative** (double adjustment) and would under-call hits; if I treated a raw column as adjusted I would over-call. The internal test (BH on the column gives 0 hits, the column itself gives 38/249) settles it in favour of "already adjusted".

```python
print('[qc] rows:', len(df))                                   # 5278
print('[qc] duplicated protein_id:', int(df.protein_id.duplicated().sum()))  # 0
print('[qc] NA per column:\n', df.isna().sum().to_string())    # all 0
print('[qc] non-numeric coercion failures:',
      {c: int(pd.to_numeric(df[c], errors="coerce").isna().sum()) for c in df.columns[1:]})  # all 0
for c in ['est_fat','padj_fat','est_breast','padj_breast']:
    df[c] = pd.to_numeric(df[c], errors='coerce')
df = df.dropna(subset=['est_fat','padj_fat','est_breast','padj_breast']).reset_index(drop=True)
print('[qc] rows after dropping NA:', len(df))                 # 5278  (5278 -> 5278)

def bh(p):
    p = np.asarray(p, float); m = len(p)
    o = np.argsort(p); r = np.empty(m, int); r[o] = np.arange(1, m+1)
    q = p * m / r
    q = np.minimum.accumulate(q[o][::-1])[::-1]
    out = np.empty(m); out[o] = np.clip(q, 0, 1); return out

for t in ['fat','breast']:
    print(t, 'reported n(padj<0.05) =', int((df[f'padj_{t}'] < 0.05).sum()),
          '| if the column were RAW p, BH would give n =', int((bh(df[f'padj_{t}']) < 0.05).sum()))
```

**Quantitative result.**
* 5,278 → 5,278 rows (0 dropped). 0 duplicates, 0 NAs, 0 coercion failures.
* `padj_fat`: min 5.457e-04, median 0.891, 38 values < 0.05, 11 < 0.01, 3 < 1e-3.
* `padj_breast`: min 3.320e-05, median 0.659, 249 values < 0.05, 78 < 0.01, 27 < 1e-3.
* BH re-applied to the columns → 0 significant for both traits ⇒ columns are already FDR-adjusted.

### Step 3 — Global direction diagnostics (is there a systematic shift?)

**Description.** For each trait, summarise the distribution of the 5,278 slopes: mean, SD, fraction negative, and a two-sided binomial test of the fraction negative against 50%.

**Decision and rationale.** This is a *necessary* diagnostic, not a formality. If nearly all slopes point one way, the "associations" partly reflect a global shift in protein levels rather than protein-specific biology (e.g. plasma-volume expansion/hemodilution, or a global treatment effect), and every downstream interpretation must be qualified. Reporting the fraction negative is the cheapest way to detect that.

```python
for t in ['fat','breast']:
    e = df[f'est_{t}']
    print(f'{t}: mean={e.mean():+.4f} sd={e.std():.4f} frac_negative={np.mean(e<0):.3f} '
          f'(n_neg={int((e<0).sum())}/{len(e)})',
          'binomial p=%.3g' % stats.binomtest(int((e<0).sum()), len(e), 0.5).pvalue)
```

**Quantitative result.**

| trait | mean slope | SD | fraction negative | binomial p vs 50% |
|---|---|---|---|---|
| Percent fat | −0.0001 | 0.0440 | 0.507 (2,677/5,278) | 0.302 |
| Breast volume | −0.0007 | 0.00134 | **0.796 (4,203/5,278)** | < 1e-300 |

⇒ Percent-fat slopes are directionally symmetric (as expected for a specific biological signal). **Breast-volume slopes are strongly skewed negative** — ~80% of all 5,278 proteins have a negative slope with breast volume. This is a red flag that must be carried into interpretation (see §4.4).

Also note the scale difference: `sd(est_fat)/sd(est_breast) = 32.8`, so the two estimate columns are **not on a common unit** and their magnitudes cannot be compared directly; only signs and within-trait ranks are comparable.

### Step 4 — Significance calls at FDR < 0.05 and the 2×2 overlap structure

**Description.** Flag each protein as significant/not for each trait at `adj.p.value < 0.05`, cross-tabulate, and test whether the overlap between the two traits exceeds chance with a Fisher exact test.

**Decision and rationale.** FDR < 0.05 (Benjamini–Hochberg, already applied by the data producers) is the standard, pre-registered-style threshold for Olink-scale screens and controls the expected proportion of false discoveries among calls; a Bonferroni threshold (0.05/5,278 ≈ 9.5e-6) would be needlessly strict for a discovery/description task, and raw p < 0.05 would give ~264 expected false positives per trait. I therefore report FDR-based counts and *also* report how many hits survive a stricter p < 0.01 / p < 1e-3 cut so the reader can see the robustness gradient. The Fisher test is used (rather than a chi-square) because the "both" cell is small relative to the margins; it is a one-sided-enrichment question reported two-sided.

```python
ALPHA = 0.05
df['sig_fat']    = df.padj_fat    < ALPHA
df['sig_breast'] = df.padj_breast < ALPHA
df['sig_both']   = df.sig_fat & df.sig_breast
print(pd.crosstab(df.sig_fat, df.sig_breast).to_string())
a = int(df.sig_both.sum()); b = int(df.sig_fat.sum()) - a
c = int(df.sig_breast.sum()) - a; d = len(df) - a - b - c
print('Fisher OR=%.1f p=%.3g' % stats.fisher_exact([[a,b],[c,d]]))
```

**Quantitative result (the filtering cascade).**

```
5,278 proteins tested
 ├─ percent fat, FDR<0.05 .............. 38   (0.72%)
 ├─ breast volume, FDR<0.05 ............ 249  (4.72%)
 ├─ significant in BOTH ................ 28
 ├─ percent fat only ................... 10
 ├─ breast volume only ................. 221
 └─ significant in neither ............. 5,019
union of significant proteins .......... 259
```

2×2 table (rows = fat, columns = breast): `[[5019, 221], [10, 28]]`. Expected overlap under independence = 38×249/5,278 = **1.8**; observed = **28**; Fisher OR = **63.6**, p = **5.1e-30**. The two traits therefore share a far larger protein signature than chance allows.

### Step 5 — Direction of effect within each trait and sign concordance between traits

**Description.** Among the significant proteins, count positive vs negative slopes per trait (binomial test vs 50/50), and for proteins significant in both, count how often the two slopes have the same sign.

**Decision and rationale.** A one-sample binomial test on the sign is the appropriate test for "is the direction of effect systematically one way", and it is assumption-light (no distributional assumption on the slopes). Testing sign concordance among the 28 shared hits asks whether the two body-composition variables move the same proteins in the same direction — a prerequisite for interpreting them as one axis rather than two.

```python
for t in ['fat','breast']:
    s = df[df[f'sig_{t}']]
    npos, nneg = int((s[f'est_{t}'] > 0).sum()), int((s[f'est_{t}'] < 0).sum())
    print(t, 'up=', npos, 'down=', nneg, 'binom p=%.3g' % stats.binomtest(nneg, npos+nneg, 0.5).pvalue)
both = df[df.sig_both]
same = int((np.sign(both.est_fat) == np.sign(both.est_breast)).sum())
print('both n=%d same sign=%d binom p=%.3g' % (len(both), same, stats.binomtest(same, len(both), 0.5).pvalue))
```

**Quantitative result.**

| set | n | up | down | binomial p |
|---|---|---|---|---|
| Percent-fat hits | 38 | 2 (`LEP`, `CFC1`) | 36 | 5.4e-09 |
| Breast-volume hits | 249 | 12 | 237 | 2.1e-55 |
| Hits significant in both | 28 | 1 (`LEP`) | 27 | — |

Sign concordance among the 28 shared proteins: **28/28 same sign, 0 opposite** (binomial p = 7.5e-09). The 12 positive breast-volume hits are `PRL, CXCL13, LEP, GAPDH, TNFAIP6, PAEP, CCL28, VEGFD, EDA2R, MZB1, CD70, RAB27B`.

### Step 6 — Cross-trait concordance of the effect estimates

**Description.** Correlate the two slope columns (Pearson and Spearman) across (i) all 5,278 proteins, (ii) the 259 significant-union proteins, (iii) the 28 shared hits; and regress the fat slope on the breast slope within the shared set.

**Decision and rationale.** Correlation of estimates is a stronger statement than correlation of p-values, because it uses effect size and sign. I report it in three nested subsets because the subsets answer different questions: the all-protein value is an unbiased description of global concordance; the union and shared values describe the *selected* hits and are inflated by selection, so they must be read as "how coherent is the hit set", not as population estimates. Spearman is reported alongside Pearson because the breast-slope distribution is skewed and heavy-tailed.

```python
for label, sub in [('all', df), ('union sig', df[df.sig_any]), ('both sig', both)]:
    print(label, len(sub), 'Pearson r=%.3f p=%.2g' % stats.pearsonr(sub.est_fat, sub.est_breast),
          'Spearman rho=%.3f' % stats.spearmanr(sub.est_fat, sub.est_breast).statistic)
sl = stats.linregress(both.est_breast, both.est_fat)
print('slope=%.2f r2=%.3f p=%.2g' % (sl.slope, sl.rvalue**2, sl.pvalue))
```

**Quantitative result.**

| subset | n | Pearson r | Spearman ρ | note |
|---|---|---|---|---|
| All proteins | 5,278 | 0.320 (p=6.6e-126) | 0.277 | weak-but-real global concordance |
| Union of hits | 259 | 0.721 (p=6.9e-43) | 0.426 | selection-inflated |
| Shared hits | 28 | **0.980** (p=9.6e-20) | 0.892 | OLS `est_fat = 35.4 × est_breast`, R² = 0.96 |

### Step 7 — Rank overlap of the two traits

**Description.** For k = 10, 25, 50, 100, compute how many of the top-k proteins by adjusted p are common to both traits; also correlate the two adjusted-p columns.

**Decision and rationale.** Rank overlap is threshold-free and therefore not sensitive to the FDR cut; it tests whether the *ordering* of evidence is shared. It is reported for several k because overlap necessarily grows with k.

```python
for k in [10, 25, 50, 100]:
    tf = set(df.nsmallest(k, 'padj_fat').protein_id); tb = set(df.nsmallest(k, 'padj_breast').protein_id)
    print(f'top-{k}: overlap={len(tf & tb)} ({100*len(tf & tb)/k:.0f}%)')
print('Spearman rho of adj-p ranks: %.3f' % stats.spearmanr(df.padj_fat, df.padj_breast).statistic)
```

**Quantitative result.** top-10 overlap = 0/10 (0%); top-25 = 8/25 (32%); top-50 = 17/50 (34%); top-100 = 36/100 (36%). Spearman ρ between the two adjusted-p vectors = 0.150. ⇒ The very strongest hits are **trait-specific** (the fat and breast lists are headed by different proteins), while a broad shared layer emerges below the top ~25.

### Step 8 — Effect-size ranking and the strongest hits

**Description.** Rank hits within each trait both by adjusted p (statistical strength) and by |estimate| (magnitude), and tabulate the shared set ordered by the *larger* of the two adjusted p-values (a conservative ordering that requires a protein to be strong for both traits).

**Decision and rationale.** Ranking by p alone favours precisely-measured proteins; ranking by |estimate| alone favours noisy ones. Reporting both makes the table honest, and using `max(padj_fat, padj_breast)` for the shared set avoids the trap of ordering by the better of the two p-values (which would overstate shared evidence).

```python
def top_table(mask, est, padj, k=20, by='abs'):
    s = df[mask].copy(); s['abse'] = s[est].abs()
    s = s.sort_values('abse', ascending=False) if by == 'abs' else s.sort_values(padj)
    return s[['protein_id', est, padj]].head(k)
```

**Quantitative result.** Effect-size separation between significant and non-significant proteins: median |estimate| = 0.0591 vs 0.0206 for fat (ratio 2.86) and 0.0015 vs 0.0008 for breast (ratio 2.04) — the hits are not marginal, they are the large-effect tail of the distribution. Full rankings are in §4.1–4.3.

### Step 9 — Curated functional annotation of the hit sets

**Description.** Annotate the significant sets against seven hand-curated gene sets (adipocyte/lipid; keratinocyte differentiation; squamous/mucosal epithelium; ECM/bone; inflammation; pregnancy/reproductive; neural), and test over-representation with a one-sided Fisher exact test using the 5,278 panel proteins as background. Run separately for the fat hits, the breast hits, and the union.

**Decision and rationale.** The table has no pathway annotation and no abundance matrix, so a formal GSEA/ORA against a curated database (Reactome, GO) was not possible offline; I therefore used explicit, auditable gene lists written into the script. This is deliberately **exploratory and hypothesis-generating**, not confirmatory: the categories were chosen after seeing the gene symbols, the tests are uncorrected for the seven categories, and the "background" is the Olink panel rather than the expressed plasma proteome. It is still informative because the odds ratios are extreme (see below) — an OR of 465 for the keratinocyte set cannot be explained by category construction alone — but I flag it as exploratory in every place it is used. Note that category membership was assigned from prior knowledge of protein function/tissue expression (cross-checkable in the Human Protein Atlas), not from this dataset.

```python
CATS = {
 'Adipocyte / lipid & energy metabolism': ['LEP','LEPR','FABP4','CFD','PLIN1','LPL','CES1','GPD1',
     'ANGPTL4','RBP4','NAMPT','PPARG','ADIPOQ','PLA2G2A','LIPE','CIDEC'],
 'Keratinocyte differentiation / cornified envelope / skin barrier': ['IVL','TGM1','TGM3','DSG1','DSG3',
     'DSG4','DSC1','DSC3','SPINK5','KLK5','KLK6','KLK7','KLK13','CST6','PI3','DEFB4A','S100A7',
     'S100A8','S100A9','KRT6A','KRT16','KRT17','FLG','LOR'],
 'Squamous / upper GI & mucosal epithelium': ['CA6','PLB1','MUC1','PGLYRP3','CBLIF','PGA3','PGA4',
     'GKN1','GKN2','TFF3','MUC5AC','AGR2','AGR3','REG1A','REG1B','REG3A','ANPEP'],
 'Extracellular matrix / connective tissue / bone': ['COL15A1','COL18A1','COL1A1','TNN','CRTAC1',
     'SOST','MMP3','MMP1','MMP9','ITGAV','ITGA11','FBLN7','FBLN5','SPARC','SPARCL1','SMOC1','SMOC2',
     'MATN2','LAMB2','TGFBI','COMP'],
 'Inflammation / immune signalling': ['CCL13','CCL24','CCL11','CCL2','IL1RAP','RELT','LY75','CD163',
     'CD80','CD86','IL6','IL17A','IL17F','TNFRSF11B','CCL28','IL32','IL19','IL23R'],
 'Pregnancy / placental & reproductive': ['PSG1','PSG2','PSG3','PSG4','CGB3','CGB5','CGB8','CFC1',
     'ENDOU','PAEP','INSL3','LHB','FSHB','CGA','PAPPA','CSH1','CSH2'],
 'Neural / synaptic': ['CLSTN2','CLSTN3','VSNL1','NRXN1','NRXN3','NCAM1','NPTX1','NPTX2','CNTN2',
     'CNTN3','CNTN5','NXPH3'],
}
sig = set(df.loc[df.padj_fat < 0.05, 'protein_id'])          # repeated for padj_breast and for the union
for cat, genes in CATS.items():
    present = [g for g in genes if g in set(df.protein_id)]
    hits = [g for g in present if g in sig]
    a, b = len(hits), len(present) - len(hits)
    c, d = len(sig) - a, len(df) - len(present) - (len(sig) - a)
    orr, pv = stats.fisher_exact([[a, b], [c, d]])
```

**Quantitative result (percent-fat hits, n = 38, background 5,278).**

| category | genes in panel | hits | OR | Fisher p | members |
|---|---|---|---|---|---|
| Keratinocyte differentiation / cornified envelope | 11 | **8** | **465.5** | 5.3e-16 | CST6, DEFB4A, DSG3, IVL, KLK13, KLK6, PI3, SPINK5 |
| Squamous / upper GI & mucosal epithelium | 14 | 5 | 88.1 | 2.8e-08 | CA6, CBLIF, MUC1, PGLYRP3, PLB1 |
| Extracellular matrix / connective tissue / bone | 20 | 5 | 52.8 | 2.1e-07 | COL15A1, CRTAC1, ITGAV, MMP3, SOST |
| Pregnancy / placental & reproductive | 10 | 3 | 64.1 | 4.0e-05 | CFC1, ENDOU, PSG1 |
| Inflammation / immune signalling | 18 | 3 | 29.9 | 2.6e-04 | CCL24, LY75, RELT |
| Adipocyte / lipid & energy metabolism | 12 | 1 | 12.8 | 0.083 | LEP |
| Neural / synaptic | 12 | 1 | 12.8 | 0.083 | CLSTN2 |

**Quantitative result (breast-volume hits, n = 249).** Inflammation 14/18 (OR 74.8, p=4.9e-16); squamous/mucosal 10/14 (OR 52.6, p=3.9e-11); neural 9/12 (OR 62.8, p=2.0e-10); ECM/bone 10/20 (OR 21.0, p=5.6e-09); keratinocyte 6/11 (OR 24.8, p=3.9e-06); pregnancy/reproductive 4/10 (OR 13.7, p=8.1e-04); **adipocyte/lipid 1/12 (OR 1.8, p=0.44 — not enriched)**.

### Step 10 — Positive-control and treatment-axis marker interrogation

**Description.** Pull a pre-specified list of 49 adiposity / hormone-axis / treatment-response markers out of the results and tabulate their estimates and adjusted p-values regardless of significance.

**Decision and rationale.** With no sample-level data, the only internal validity checks available are (a) *positive controls* — proteins whose relationship to adiposity is textbook-established must come out in the expected direction, and (b) *treatment-axis markers* — proteins that are pure readouts of gonadal androgen output or oestrogen action tell me what the body-composition variables are actually tracking. Pre-specifying the list and printing everything (including nulls) prevents cherry-picking.

```python
cand = ['LEP','LEPR','ADIPOQ','INSR','IGF1','IGF2','IGFBP1','IGFBP2','IGFBP3','SHBG','RETN','NAMPT',
        'FABP4','CFD','PLIN1','PLIN2','LPL','CES1','GPD1','ANGPTL4','ADM','RBP4','SERPINA6','DHEAS',
        'INSL3','FSHB','LHB','CGA','PRL','GH1','GHR','TSHB','TTR','APOA1','APOB','PCSK9','SOST','OPG',
        'TNFRSF11B','MMP3','MMP1','MMP9','CCL2','IL6','CRP','PLA2G2A','SAA1','HGF','IGFBP7']
sub = df[df.protein_id.isin(cand)]
```

**Quantitative result.** 40 of the 49 requested markers are in the panel (absent: ADIPOQ, IGF1, IGF2, PLIN2, DHEAS, CGA, OPG, CRP, SAA1). Highlights:

* **LEP (leptin) — positive control passes strongly**: `est_fat = +0.1962`, `padj_fat = 5.46e-04` (joint-smallest p in the fat analysis, rank 2 of 5,278), `est_breast = +0.00527`, `padj_breast = 0.00307`. Direction is exactly as expected (higher body fat → higher circulating leptin).
* **INSL3 (Leydig-cell / testicular androgen marker)**: `est_breast = −0.0152`, `padj_breast = 3.3e-05` — the single strongest breast-volume association in the whole panel; its fat association is null (`padj_fat = 0.32`).
* **PRL (prolactin)**: `est_breast = +0.00435`, `padj_breast = 2.8e-04` (2nd strongest breast hit); fat association null (`padj_fat = 0.44`).
* **SHBG**: `est_breast = +0.0014`, `padj_breast = 0.093` (borderline, not significant); fat null.
* **Classical adipokines are largely null**: FABP4 (padj_fat 0.56), CFD/adipsin (0.15), RBP4 (0.56), NAMPT/visfatin (0.29), LEPR (0.90), IGFBP1 (0.16), IGFBP2 (0.17), LPL (0.89), PLIN1 (0.91), INSR (0.92). Only LEP passes.
* Other treatment/axis markers null for fat: LHB, FSHB, SERPINA6/CBG, GH1, PCSK9, TNFRSF11B/OPG.

---

## 4. Results

### 4.1 Proteins that track **percent body fat** (FDR < 0.05): 38 proteins, 36 down / 2 up

Complete list, ordered by adjusted p. Slope = change in protein NPX per +1 percentage point body fat.

| protein | est_fat | padj_fat | est_breast | padj_breast | direction |
|---|---|---|---|---|---|
| CA6 | −0.1393 | 5.46e-04 | −0.00337 | 8.46e-04 | down with fat |
| **LEP** | **+0.1962** | **5.46e-04** | +0.00527 | 3.07e-03 | **up with fat** |
| PLB1 | −0.0839 | 5.46e-04 | −0.00199 | 8.46e-04 | down |
| CCL24 | −0.1025 | 1.81e-03 | −0.00244 | 7.33e-04 | down |
| CYTL1 | −0.0761 | 2.89e-03 | −0.00152 | 3.33e-02 | down |
| DPEP1 | −0.0447 | 2.89e-03 | −0.00125 | 1.79e-03 | down |
| ENDOU | −0.0581 | 2.89e-03 | −0.00119 | 3.95e-02 | down |
| PGLYRP3 | −0.0848 | 2.89e-03 | −0.00243 | 7.33e-04 | down |
| PSG1 | −0.0977 | 2.89e-03 | −0.00191 | 1.67e-02 | down |
| WIF1 | −0.0463 | 2.89e-03 | −0.00080 | 0.120 | down (fat-specific) |
| CST6 | −0.0698 | 4.89e-03 | −0.00212 | 3.76e-04 | down |
| IVL | −0.0736 | 1.01e-02 | −0.00172 | 2.25e-02 | down |
| PI3 | −0.0964 | 1.28e-02 | −0.00264 | 6.24e-03 | down |
| DEFB4A | −0.2094 | 1.44e-02 | −0.00577 | 2.76e-03 | down |
| ENPP5 | −0.0537 | 1.44e-02 | −0.00157 | 8.46e-04 | down |
| MMP3 | −0.1123 | 1.53e-02 | −0.00353 | 2.21e-03 | down |
| MUC1 | −0.1669 | 1.53e-02 | −0.00528 | 3.07e-04 | down |
| LY75 | −0.0499 | 1.86e-02 | −0.00116 | 2.55e-02 | down |
| RELT | −0.0449 | 1.86e-02 | −0.00086 | 0.0998 | down (fat-specific) |
| SPINK5 | −0.0572 | 1.86e-02 | −0.00166 | 5.63e-03 | down |
| VIT | −0.0628 | 1.86e-02 | −0.00200 | 2.66e-03 | down |
| CLSTN2 | −0.0637 | 2.07e-02 | −0.00234 | 4.60e-04 | down |
| DSG3 | −0.0470 | 2.07e-02 | −0.00101 | 0.0765 | down (fat-specific) |
| CBLIF | −0.0563 | 2.50e-02 | −0.00184 | 1.29e-03 | down |
| **CFC1** | **+0.0706** | **2.50e-02** | +0.00120 | 0.205 | **up (fat-specific)** |
| KLK6 | −0.0380 | 3.07e-02 | −0.00109 | 1.96e-02 | down |
| PPY | −0.0942 | 3.07e-02 | −0.00215 | 3.14e-02 | down |
| ART3 | −0.0462 | 3.36e-02 | −0.00084 | 0.174 | down (fat-specific) |
| CEACAM19 | −0.0394 | 3.53e-02 | −0.00097 | 4.17e-02 | down |
| IGSF21 | −0.0486 | 3.53e-02 | −0.00151 | 1.48e-02 | down |
| CRTAC1 | −0.0418 | 4.37e-02 | −0.00083 | 0.0924 | down (fat-specific) |
| FGFBP2 | −0.0600 | 4.37e-02 | −0.00199 | 7.33e-04 | down |
| ITGAV | −0.0251 | 4.48e-02 | −0.00052 | 0.107 | down (fat-specific) |
| KLK13 | −0.0496 | 4.48e-02 | −0.00092 | 0.119 | down (fat-specific) |
| SOST | −0.0546 | 4.48e-02 | −0.00195 | 2.76e-03 | down |
| XPNPEP2 | −0.0447 | 4.48e-02 | −0.00127 | 1.47e-02 | down |
| COL15A1 | −0.0396 | 4.72e-02 | −0.00073 | 0.212 | down (fat-specific) |
| MAPK4 | −0.2175 | 4.72e-02 | −0.00331 | 0.332 | down (fat-specific) |

Largest absolute effects: MAPK4 (−0.217), DEFB4A (−0.209), LEP (+0.196), MUC1 (−0.167), CA6 (−0.139), MMP3 (−0.112), CCL24 (−0.102), PSG1 (−0.098), PI3 (−0.096), PPY (−0.094).

### 4.2 Proteins that track **breast volume** (FDR < 0.05): 249 proteins, 237 down / 12 up

Top 20 by adjusted p:

| protein | est_breast | padj_breast | est_fat | padj_fat |
|---|---|---|---|---|
| INSL3 | −0.01515 | 3.32e-05 | −0.2058 | 0.317 |
| PRL | +0.00435 | 2.79e-04 | +0.0555 | 0.441 |
| PROK1 | −0.00428 | 3.07e-04 | −0.0691 | 0.210 |
| MUC1 | −0.00528 | 3.07e-04 | −0.1669 | 0.0153 |
| SPINT3 | −0.02035 | 3.07e-04 | −0.3223 | 0.255 |
| PM20D1 | −0.00431 | 3.07e-04 | −0.1018 | 0.0969 |
| PTPRH | −0.00227 | 3.26e-04 | −0.0589 | 0.134 |
| B3GNT7 | −0.00155 | 3.26e-04 | −0.0332 | 0.173 |
| PAMR1 | −0.00174 | 3.76e-04 | −0.0186 | 0.693 |
| CST6 | −0.00212 | 3.76e-04 | −0.0698 | 4.89e-03 |
| CLSTN2 | −0.00234 | 4.60e-04 | −0.0637 | 0.0207 |
| EDDM3B | −0.00686 | 5.85e-04 | −0.1228 | 0.165 |
| CXCL13 | +0.00592 | 6.67e-04 | +0.0587 | 0.704 |
| MDGA1 | −0.00168 | 7.33e-04 | −0.0454 | 0.130 |
| PTPRZ1 | −0.00164 | 7.33e-04 | −0.0313 | 0.244 |
| PGLYRP3 | −0.00243 | 7.33e-04 | −0.0848 | 2.89e-03 |
| FGFBP2 | −0.00199 | 7.33e-04 | −0.0600 | 4.37e-02 |
| CCL24 | −0.00244 | 7.33e-04 | −0.1025 | 1.81e-03 |
| TNN | −0.00120 | 7.39e-04 | −0.0349 | 0.0676 |
| NCAM1 | −0.00200 | 8.46e-04 | −0.0383 | 0.234 |

The 12 positive breast-volume hits: **PRL** (+0.00435, 2.8e-04), CXCL13 (+0.00592, 6.7e-04), **LEP** (+0.00527, 3.1e-03), GAPDH (+0.00080, 7.7e-03), TNFAIP6 (+0.00160, 0.027), PAEP (+0.00249, 0.030), CCL28 (+0.00215, 0.033), VEGFD (+0.00107, 0.038), EDA2R (+0.00088, 0.044), MZB1 (+0.00101, 0.045), CD70 (+0.00107, 0.046), RAB27B (+0.00066, 0.049).

### 4.3 The **shared** signature: 28 proteins significant for both traits

All 28 have the same sign for both traits (27 negative, LEP positive). Ordered by `max(padj_fat, padj_breast)`:

| protein | est_fat | padj_fat | est_breast | padj_breast | max padj |
|---|---|---|---|---|---|
| CA6 | −0.1393 | 5.46e-04 | −0.00337 | 8.46e-04 | 8.5e-04 |
| PLB1 | −0.0839 | 5.46e-04 | −0.00199 | 8.46e-04 | 8.5e-04 |
| CCL24 | −0.1025 | 1.81e-03 | −0.00244 | 7.33e-04 | 1.8e-03 |
| PGLYRP3 | −0.0848 | 2.89e-03 | −0.00243 | 7.33e-04 | 2.9e-03 |
| LEP | +0.1962 | 5.46e-04 | +0.00527 | 3.07e-03 | 3.1e-03 |
| DPEP1 | −0.0447 | 2.89e-03 | −0.00125 | 1.79e-03 | 2.9e-03 |
| CST6 | −0.0698 | 4.89e-03 | −0.00212 | 3.76e-04 | 4.9e-03 |
| PI3 | −0.0964 | 1.28e-02 | −0.00264 | 6.24e-03 | 1.3e-02 |
| ENPP5 | −0.0537 | 1.44e-02 | −0.00157 | 8.46e-04 | 1.4e-02 |
| DEFB4A | −0.2094 | 1.44e-02 | −0.00577 | 2.76e-03 | 1.4e-02 |
| MMP3 | −0.1123 | 1.53e-02 | −0.00353 | 2.21e-03 | 1.5e-02 |
| MUC1 | −0.1669 | 1.53e-02 | −0.00528 | 3.07e-04 | 1.5e-02 |
| PSG1 | −0.0977 | 2.89e-03 | −0.00191 | 1.67e-02 | 1.7e-02 |
| SPINK5 | −0.0572 | 1.86e-02 | −0.00166 | 5.63e-03 | 1.9e-02 |
| VIT | −0.0628 | 1.86e-02 | −0.00200 | 2.66e-03 | 1.9e-02 |
| CLSTN2 | −0.0637 | 2.07e-02 | −0.00234 | 4.60e-04 | 2.1e-02 |
| IVL | −0.0736 | 1.01e-02 | −0.00172 | 2.25e-02 | 2.3e-02 |
| CBLIF | −0.0563 | 2.50e-02 | −0.00184 | 1.29e-03 | 2.5e-02 |
| LY75 | −0.0499 | 1.86e-02 | −0.00116 | 2.55e-02 | 2.6e-02 |
| KLK6 | −0.0380 | 3.07e-02 | −0.00109 | 1.96e-02 | 3.1e-02 |
| PPY | −0.0942 | 3.07e-02 | −0.00215 | 3.14e-02 | 3.1e-02 |
| CYTL1 | −0.0761 | 2.89e-03 | −0.00152 | 3.33e-02 | 3.3e-02 |
| IGSF21 | −0.0486 | 3.53e-02 | −0.00151 | 1.48e-02 | 3.5e-02 |
| ENDOU | −0.0581 | 2.89e-03 | −0.00119 | 3.95e-02 | 4.0e-02 |
| CEACAM19 | −0.0394 | 3.53e-02 | −0.00097 | 4.17e-02 | 4.2e-02 |
| FGFBP2 | −0.0600 | 4.37e-02 | −0.00199 | 7.33e-04 | 4.4e-02 |
| SOST | −0.0546 | 4.48e-02 | −0.00195 | 2.76e-03 | 4.5e-02 |
| XPNPEP2 | −0.0447 | 4.48e-02 | −0.00127 | 1.47e-02 | 4.5e-02 |

**Fat-specific (10):** WIF1, RELT, DSG3, CFC1 (the only positive one), ART3, CRTAC1, ITGAV, KLK13, COL15A1, MAPK4.
**Breast-specific (221)** — headed by INSL3, PRL, PM20D1, SPINT3, PROK1, PTPRH, B3GNT7, PAMR1, EDDM3B, CXCL13.

### 4.4 Biological / clinical interpretation

**(a) The positive control validates the analysis and pins down what "fat" means here.** Leptin (`LEP`) is the 2nd-strongest fat association in the entire panel (+0.196 NPX per +1 percentage point fat, padj = 5.5e-04) and the *only* classical adipocyte protein that is significant. This is exactly the textbook relationship (adipose-tissue leptin secretion rises with fat mass [1,2]) and it means the percent-fat variable is behaving like a real adiposity measure, not noise. Conversely, the classical adipokines that were measured — FABP4, CFD/adipsin, RBP4, NAMPT, LEPR, LPL, PLIN1 — are all null (padj ≥ 0.15), and adiponectin (`ADIPOQ`) is not on the panel. So the fat signature is **not** a generic "adipokine panel" response; it is LEP plus a specific epithelial/ECM cluster.

**(b) The percent-fat signature is dominated by keratinocyte / stratified-epithelial and mucosal proteins.** 8 of the 11 keratinocyte-differentiation genes present in the panel are fat hits (OR 465, p = 5.3e-16): involucrin (`IVL`), desmoglein-3 (`DSG3`), `SPINK5`/LEKTI, kallikreins `KLK6` and `KLK13`, cystatin-E/M (`CST6`), elafin (`PI3`), β-defensin-4A (`DEFB4A`); plus 5/14 squamous-mucosal genes (`CA6`, `PLB1`, `PGLYRP3`, `MUC1`, `CBLIF`) and ECM/bone genes (`MMP3`, `SOST`, `COL15A1`, `CRTAC1`, `ITGAV`). These are all secreted proteins of cornified/squamous epithelium and its appendages [3–7]. The direction is uniformly negative: **higher percent fat goes with lower circulating concentrations of the structural/barrier proteins of stratified epithelium.** Two readings are compatible with the data and cannot be separated here: (i) a genuine adiposity–epidermal axis (adiposity is known to perturb epidermal differentiation and barrier function), and (ii) a shared upstream hormonal driver, because ovarian/testicular androgens are major trophic regulators of sebaceous and keratinocyte biology, and in this cohort androgen suppression and fat gain occur together. Note also that essentially none of these proteins is a classical adipocyte product — they are epithelial, so a purely adipose-secretory explanation is not available.

**(c) Breast volume is largely a readout of treatment exposure, not of breast tissue.** Two observations make this the most defensible reading. First, the top breast association in the entire panel is `INSL3` (−0.0152, padj = 3.3e-05), a protein produced essentially only by testicular Leydig cells and used as a circulating index of Leydig-cell/androgen status [8]; its fat association is null. Second, the second-strongest is `PRL` (+0.00435, padj = 2.8e-04), and oestrogen is the classic stimulus to lactotroph prolactin secretion [9]. A protein that falls when gonadal androgens are suppressed and a protein that rises with oestrogen exposure both tracking breast volume is the signature of **cumulative GAHT exposure** (dose × time), which is also what drives breast growth. Consistent with this, 79.6% of *all* 5,278 proteins have a negative breast-volume slope (binomial p < 1e-300), i.e. there is a global downward shift of the plasma proteome with breast volume. Plasma-volume expansion under oestrogen (haemodilution) is a well-documented physiological effect [10] and would produce exactly this pattern — a broad, directionally uniform dilution of circulating protein concentrations that co-varies with oestrogen exposure and therefore with breast volume. Any breast-volume "hit" list must therefore be read as **partly a treatment-exposure/dilution signature**, and only the trait-specific part (e.g. the fat-specific 10) as body-composition biology.

**(d) The 28 shared proteins are a coherent "epithelial–matrix–inflammatory" module, but their sharing is not evidence of a common body-composition mechanism.** All 28 move in the same direction for both traits, with r = 0.98 between the two slope vectors (R² = 0.96). Given (c), the most parsimonious explanation is that both body-composition variables are collinear with treatment exposure/time, so the shared set is a **GAHT-exposure signature** that both traits inherit, not proof that fat and breast tissue act through the same proteins. The strongest *fat-specific* candidates — those whose breast association is clearly null — are WIF1, RELT, DSG3, CFC1 (+), ART3, CRTAC1, ITGAV, KLK13, COL15A1 and MAPK4; these are the proteins most likely to reflect adiposity per se.

**(e) Mechanistic notes on individual shared proteins.** `SOST`/sclerostin (negative for both) is the osteocyte-derived Wnt antagonist and a bone-turnover readout [11] — its decline with fat and breast volume fits the known inverse relationship between adiposity and sclerostin and the bone-active hormonal changes of GAHT. `MMP3` (stromelysin-1) and `COL15A1` are matrix-remodelling genes. `PSG1`, `CFC1`, `ENDOU` and `PAEP` are placental/pregnancy-associated [12], which is notable because the cohort contains a pregnancy comparator arm — their appearance here argues that the model's within-person contrasts are being informed by the pregnancy arm as well, and this should be checked before any of these three is interpreted as a GAHT effect. `MUC1`, `PGLYRP3`, `CBLIF` (gastric intrinsic factor) and `CA6` (carbonic anhydrase VI) are mucosal secretions.

### 4.5 What this analysis cannot conclude (limitations)

1. **No re-fitting was possible.** Only pre-computed per-protein results are provided: no NPX matrix, no sample metadata, no arm labels, no group sizes, no confidence intervals, no standard errors, no raw p-values. Every statistic reported above is a re-description of the supplied columns, not an independent estimate. I could not verify the model specification, check convergence, or recompute p-values.
2. **Single-predictor models ⇒ no mutual adjustment.** Percent fat and breast volume were each modelled alone. The 28 "shared" proteins are therefore *not* shown to be independently associated with both traits; given that the two traits are themselves correlated and both move with treatment, the shared set is very likely one signal counted twice.
3. **Direction of causality is unknown and not identifiable.** A slope of "protein per unit fat" is symmetric — it is equally consistent with adipose tissue driving the protein, the protein driving adiposity, or a third variable (oestrogen dose, time on treatment, plasma volume) driving both. Nothing in this table can order these.
4. **Within- vs between-person effects are blended.** A random-intercept model with a time-varying predictor returns a variance-weighted mixture of the within-person and between-person slopes [13]; with only two time points the two are not separable. "Correlates with *change*" is therefore an interpretation, not a demonstrated within-person effect.
5. **Confounding by treatment exposure/time.** Both body-composition variables increase during feminizing GAHT, so both are collinear with time-on-treatment and cumulative oestrogen/antiandrogen exposure. The global negative skew of breast-volume slopes (79.6%) and the INSL3/PRL pattern are direct internal evidence of this. I cannot adjust for it with the data at hand; a model including time (or oestradiol level) as a covariate would be required.
6. **Units are not comparable across traits.** `sd(est_fat)/sd(est_breast) = 32.8` and the breast-volume unit is not stated in the file. Cross-trait comparisons of *magnitude* are invalid; only signs, ranks and within-trait ratios are used here.
7. **The functional annotation is exploratory.** The seven categories were hand-curated, chosen after inspecting the hit list, and tested without correction for multiple categories against the Olink panel (not the expressed proteome) as background. The odds ratios are large enough to be interesting, but these are hypotheses, not confirmatory enrichment results.
8. **Coverage gaps.** Adiponectin, IGF-1, IGF-2 and CRP are absent from the panel, so "not significant" for those cannot be claimed. Effect estimates for proteins near the detection limit may be attenuated.
9. **Generality.** Findings are specific to a 6-month feminizing-GAHT cohort with two antiandrogen regimens; no arm-stratified analysis was possible, and nothing here establishes what happens beyond 6 months.

### 4.6 Reproducibility

| file | content |
|---|---|
| `analyze_bodycomp.py` | main pipeline (steps 1–10, figure, table export) |
| `followup_checks.py` | adjusted-p verification, effect-size separation, marker panel, shared-set regression |
| `cat_by_trait.py` | per-trait curated-category enrichment |
| `output/analysis_log.txt` | full console log of the main pipeline (467 lines) |
| `output/followup_log.txt`, `output/cat_by_trait_log.txt` | console logs of the checks |
| `output/bodycomp_protein_associations_full.csv` | all 5,278 proteins with estimates, adjusted p, significance flags, direction labels |
| `output/bodycomp_proteins_significant_both.csv` | the 28 shared proteins |
| `output/bodycomp_functional_categories.csv` | category enrichment table |
| `output/fig1_bodycomp_proteome.png` | 4-panel figure: volcano plots per trait, cross-trait slope concordance, top-20 shared proteins |

Run with: `PYTHONPATH=./pylibs python3 analyze_bodycomp.py`.

---

## 5. References

1. Zhang Y, Proenca R, Maffei M, Barone M, Leopold L, Friedman JM. Positional cloning of the mouse obese gene and its human homologue. *Nature* 1994;372:425–432. doi:10.1038/372425a0.
2. Considine RV, Sinha MK, Heiman ML, et al. Serum immunoreactive-leptin concentrations in normal-weight and obese humans. *N Engl J Med* 1996;334:292–295. doi:10.1056/NEJM199602013340503.
3. Chavanas S, Bodemer C, Rochat A, et al. Mutations in SPINK5, encoding a serine protease inhibitor, cause Netherton syndrome. *Nat Genet* 2000;25:141–142. doi:10.1038/75997. (SPINK5/LEKTI as a cornified-envelope regulator.)
4. Amagai M, Klaus-Kovtun V, Stanley JR. Autoantibodies against a desmosomal cadherin in pemphigus vulgaris. *Cell* 1991;67:869–877. doi:10.1016/0092-8674(91)90360-B. (Desmoglein-3 in epidermal adhesion.)
5. Uhlén M, Fagerberg L, Hallström BM, et al. Tissue-based map of the human proteome. *Science* 2015;347:1260419. doi:10.1126/science.1260419. (Human Protein Atlas, proteinatlas.org — tissue-expression evidence used to assign CA6, PLB1, PGLYRP3, CBLIF, IVL, DSG3, KLK6/KLK13, CST6, PI3, DEFB4A to squamous/epidermal or mucosal origin.)
6. Olink Proteomics AB. *Olink Explore HT* product documentation, 2023 (olink.com). (Platform: ~5.4k-plex antibody-based plasma proteomics; NPX = normalised protein eXtension, log2 scale.)
7. Benjamini Y, Hochberg Y. Controlling the false discovery rate: a practical and powerful approach to multiple testing. *J R Stat Soc Series B* 1995;57:289–300. doi:10.1111/j.2517-6161.1995.tb02031.x. (FDR procedure assumed for the supplied `adj.p.value` columns; verified internally in Step 2.)
8. Ivell R, Anand-Ivell R. Biology of insulin-like factor 3 in human reproduction. *Hum Reprod Update* 2009;15:463–476. doi:10.1093/humupd/dmp011. (INSL3 as a Leydig-cell-specific circulating marker of androgen status.)
9. Freeman ME, Kanyicska B, Lerant A, Nagy G. Prolactin: structure, function, and regulation of secretion. *Physiol Rev* 2000;80:1523–1631. doi:10.1152/physrev.2000.80.4.1523. (Oestrogen as a stimulator of lactotroph prolactin secretion.)
10. Stachenfeld NS. Sex hormone effects on body fluid regulation. *Exerc Sport Sci Rev* 2008;36:152–159. (Oestrogen-driven plasma-volume expansion — the physiological basis for the haemodilution interpretation of the global negative breast-volume shift.)
11. Bonewald LF. The amazing osteocyte. *J Bone Miner Res* 2011;26:229–238. doi:10.1002/jbmr.320. (SOST/sclerostin as the osteocyte-derived Wnt antagonist and bone-turnover marker.)
12. Human Protein Atlas (proteinatlas.org) — gene entries PSG1, CFC1, ENDOU, PAEP, used as database evidence for placenta-/pregnancy-enriched expression. Database described in ref. 5 (Uhlén et al. 2015).
13. Bates D, Mächler M, Bolker B, Walker S. Fitting linear mixed-effects models using lme4. *J Stat Softw* 2015;67:1–48. doi:10.18637/jss.v067.i01. (Mixed-model formulation with random intercepts; basis for the within/between-variance-weighted-slope caveat.)
14. Data file analysed: `41591_2025_4023_MOESM2_ESM(Supplementary Table 4).csv`, Supplementary Table 4 of the associated *Nature Medicine* 2025 feminizing-GAHT plasma-proteomics study (as described in the task specification; the paper itself was not consulted).
