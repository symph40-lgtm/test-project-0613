import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
import pytest
from mtpro.schema import assert_same_adjustment, assert_t0_mode, BRONZE_OHLCV, SILVER_CONSENSUS_REGISTRY

def test_c2_mixed_adjustment_rejected():
    with pytest.raises(AssertionError):
        assert_same_adjustment(True, False)
    assert_same_adjustment(True, True)

def test_c2_price_adjusted_column_required():
    assert "price_adjusted" in BRONZE_OHLCV.names

def test_c3_domestic_a1_only():
    assert_t0_mode("A1_open", "005930")
    with pytest.raises(AssertionError):
        assert_t0_mode("release_time", "KOSPI200")
    with pytest.raises(AssertionError):
        assert_t0_mode("A1_open", "SOXX")
    assert "t0_mode" in SILVER_CONSENSUS_REGISTRY.names

def test_event_types_single_source_of_truth():
    import yaml, pathlib
    from mtpro.schema import EVENT_TYPES
    from mtpro.events.registry import EVENT_TYPES as REG
    cfg = yaml.safe_load((pathlib.Path(__file__).resolve().parents[1] / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
    assert set(EVENT_TYPES) == set(REG) == set(cfg["grade_a_events"]) and len(REG) == 7
