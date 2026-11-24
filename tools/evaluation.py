"""Score a locked, group-disjoint release manifest against one fixed detector route.
This is a developer tool. The browser never transmits predictions or media to it.
"""
import argparse
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path


def _left_tail(k, n, probability):
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    if k >= n * probability:
        return 1.0 - _left_tail(n - k - 1, n, 1.0 - probability)
    log_pmf = (math.lgamma(n+1)-math.lgamma(k+1)-math.lgamma(n-k+1)
               + k*math.log(probability)+(n-k)*math.log1p(-probability))
    term = math.exp(log_pmf)
    total = term
    while k and term > total * 1e-15:
        term *= k / (n-k+1) * ((1-probability)/probability)
        k -= 1
        total += term
    return min(1.0,total)


def upper_bound(k, n, alpha=.05):
    if not n:
        return None
    if k == n:
        return 1.0
    if k == 0:
        return -math.expm1(math.log(alpha) / n)
    lo, hi = 0., 1.
    for _ in range(60):
        mid = (lo+hi)/2
        if _left_tail(k,n,mid) > alpha:
            lo = mid
        else:
            hi = mid
    return hi


def lower_bound(k, n, alpha=.05):
    return None if not n else 1.0-upper_bound(n-k,n,alpha)


def ratio(a, b):
    return a/b if b else None


def summarize(pairs, target_prevalence):
    tp = fp = fn = tn = abstentions = failures = 0
    for origin, decision in pairs:
        positive = origin == "generated"
        flagged = decision == "label"
        tp += positive and flagged
        fp += not positive and flagged
        fn += positive and not flagged
        tn += not positive and not flagged
        abstentions += decision in {"abstain","unsupported","failed"}
        failures += decision == "failed"
    n = tp+fp+fn+tn
    recall = ratio(tp,tp+fn)
    fpr = ratio(fp,fp+tn)
    def project(prevalence, r, f):
        if r is None or f is None:
            return None
        return ratio(prevalence*r, prevalence*r + (1-prevalence)*f)
    # Bonferroni allocation ensures at least 95% joint coverage for the two
    # independent-binomial bounds used in the projected precision gate.
    worst_recall = lower_bound(tp,tp+fn,.025)
    worst_fpr = upper_bound(fp,fp+tn,.025)
    projected = project(target_prevalence, worst_recall, worst_fpr)
    return dict(n=n,tp=tp,fp=fp,fn=fn,tn=tn,abstentions=abstentions,failures=failures,
                precision=ratio(tp,tp+fp),recall=recall,fpr=fpr,coverage=ratio(n-abstentions,n),
                fpr_upper95=upper_bound(fp,fp+tn),recall_lower95=lower_bound(tp,tp+fn),
                target_prevalence=target_prevalence, projected_precision_lower95=projected,
                prevalence_sensitivity={str(p): project(p,recall,fpr) for p in (.01,.05,.1,.25,.5)},
                passes=bool(tp and projected is not None and projected>=.99
                            and upper_bound(fp,fp+tn)<=.001 and recall>=.5))


def evaluate(manifest, predictions, prevalence=.01):
    if not 0 < prevalence < 1:
        raise ValueError("prevalence must lie strictly between 0 and 1")
    release, groups, units, seen = {}, {}, set(), set()
    for row in manifest:
        digest, group, split = row["sha256"], row["group"], row["split"]
        if not re.fullmatch("[a-f0-9]{64}",digest) or digest in seen:
            raise ValueError("invalid or duplicate asset digest")
        seen.add(digest)
        if (not all(isinstance(row.get(k),str) and row[k].strip() for k in ("group","source","license","slice"))
            or row["kind"] not in {"image","video"} or row["origin"] not in {"genuine","generated","mixed"}
            or split not in {"train","validation","calibration","test","release"}):
            raise ValueError("invalid asset provenance, modality, split, rights or ground truth")
        if groups.setdefault(group,split) != split:
            raise ValueError("source group leaks across dataset splits")
        if split == "release":
            if group in units:
                raise ValueError("release intervals require independent source groups; preselect one asset per group")
            units.add(group)
            release[digest] = row
    by_kind, by_slice, matched, versions = defaultdict(list),defaultdict(list),set(),set()
    for row in predictions:
        digest, decision = row["sha256"],row["decision"]
        if digest not in release or digest in matched:
            raise ValueError("unexpected or duplicate prediction")
        if decision not in {"label","clear","abstain","failed","unsupported"}:
            raise ValueError("unknown decision")
        if not row.get("policy") or not row.get("route"):
            raise ValueError("missing policy/route version")
        versions.add((row["policy"],row["route"]))
        matched.add(digest)
        asset = release[digest]
        observation = (asset["origin"],decision)
        by_kind[asset["kind"]].append(observation)
        by_slice[(asset["kind"],asset["slice"])].append(observation)
    if not release or matched != set(release) or len(versions)!=1:
        raise ValueError("predictions must cover every release asset using a single frozen policy and route")
    results = {k:summarize(by_kind[k],prevalence) for k in ("image","video")}
    return dict(policy=next(iter(versions))[0],route=next(iter(versions))[1],
                by_modality=results, by_slice={f"{k}/{s}":summarize(v,prevalence) for (k,s),v in by_slice.items()},
                passes=all(r["passes"] for r in results.values()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest",type=Path)
    parser.add_argument("predictions",type=Path)
    parser.add_argument("--prevalence",type=float,default=.01)
    parser.add_argument("--require-pass",action="store_true")
    args = parser.parse_args()
    def read(path):
        data = path.read_bytes()
        return [json.loads(line) for line in data.splitlines() if line.strip()], hashlib.sha256(data).hexdigest()
    try:
        assets, a = read(args.manifest)
        predictions, b = read(args.predictions)
        report = evaluate(assets,predictions,args.prevalence)
        print(json.dumps(dict(report,manifest_sha256=a,predictions_sha256=b),indent=2,allow_nan=False))
        return int(args.require_pass and not report["passes"])
    except (ValueError,KeyError,OSError,TypeError) as e:
        print(str(e),file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
