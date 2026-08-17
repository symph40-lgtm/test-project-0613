"""부품 4 Flow Impact 패널 산출 잡. 실행(cwd=mtpro): `.venv\\Scripts\\python.exe jobs\\build_flow.py`
입력 bronze(investor_flow·ohlcv_unadj·ohlcv_adj[, investor_flow_constituents+constituents]) → gold/flow_panel.parquet + 요약 JSON(stdout, logs/flow_panel_summary.json)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from mtpro import settings                                  # noqa: E402
from mtpro.components import flow                           # noqa: E402

if __name__ == "__main__":
    settings.ensure_dirs()
    panel = flow.build_flow_panel()
    summ = {"engine_ver": flow.ENGINE_VER, "index_unit": flow.load_config().get("flow", {}).get("index_unit"),
            "rows": int(len(panel)), "path": str(flow.P_FLOW_PANEL), "scopes": flow.summarize_panel(panel)}
    (settings.LOG_DIR / "flow_panel_summary.json").write_text(json.dumps(summ, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(summ, ensure_ascii=False, indent=1, default=str))
    # docs/mtpro-t3a-ingest.md 에 부품 4 패널 요약 절을 덧붙인다(있으면 교체)
    doc = ROOT / "docs" / "mtpro-t3a-ingest.md"
    if doc.exists():
        txt = doc.read_text(encoding="utf-8")
        marker = "## 부품 4 flow_panel 요약"
        L = [marker, "", f"- `jobs/build_flow.py` → `data/gold/flow_panel.parquet` (engine {flow.ENGINE_VER}, KOSPI200 수급 소스 = `{summ['index_unit']}`), 행 {summ['rows']:,}",
             "", "| scope | 행 | 구간 | None 비율 (norm/β/잔차z/추세z) | \\|β\\|>1 일수(비율) | 잔차 z 2.5~97.5% | 잔차 z std | β 중앙값(외국인/기관) |", "|---|---|---|---|---|---|---|---|"]
        for sc, v in summ["scopes"].items():
            nr = v["none_ratio"]
            L.append(f"| {sc} | {v['rows']} | {v['range'][0]}~{v['range'][1]} | {nr['foreign_norm']}/{nr['flow_beta_foreign']}/{nr['flow_impact_residual_z']}/{nr['flow_trend_z']} | {v['beta_extreme_days']} ({v['beta_extreme_ratio']}) | {v['resid_z_p2_5_p97_5']} | {v['resid_z_std']} | {v['beta_foreign_median']}/{v['beta_inst_median']} |")
        L.append("")
        section = "\n".join(L)
        if marker in txt:
            head = txt.split(marker)[0]
            txt = head + section
        else:
            txt = txt.rstrip("\n") + "\n\n" + section
        doc.write_text(txt, encoding="utf-8")
