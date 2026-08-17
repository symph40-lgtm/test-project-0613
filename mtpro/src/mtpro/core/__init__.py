"""MT-PRO 순수 함수 코어 (데이터 적재·파이프라인 없음).

`errata` 모듈은 WORKORDER_MTPRO_v10.1 부록 A 결함 6건(A-1~A-6)의 수정 구현이다.
각 함수는 tests/test_errata_a*.py 의 검출 테스트가 먼저 작성된 뒤 구현되었다(test-first).
"""
from mtpro.core.errata import (  # noqa: F401
    ATTRIBUTION_QUALITY_FORMULA,
    RELEASE_TIME_WINDOW_MIN,
    REGIMES,
    RegimeClassification,
    asymmetry,
    attribution_quality,
    classify_regime,
    delta_from_history,
    energy,
    err_z_std_check,
    ewma_mean,
    expected_std_rolling,
    regime_transition,
)
