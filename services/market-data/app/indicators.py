from math import sqrt
from statistics import pstdev
from typing import List

from app.models import DailyBar, Indicators, Macd


def calculate_indicators(bars: List[DailyBar]) -> Indicators:
    closes = [bar.close for bar in bars]
    volumes = [bar.volume for bar in bars]
    returns = [closes[index] / closes[index - 1] - 1 for index in range(1, len(closes))]
    peaks, peak, max_drawdown = [], closes[0], 0.0
    for close in closes:
        peak = max(peak, close)
        peaks.append(peak)
        max_drawdown = min(max_drawdown, close / peak - 1)

    macd_line_values = [fast - slow for fast, slow in zip(_ema(closes, 12), _ema(closes, 26))]
    signal_values = _ema(macd_line_values, 9)
    line, signal = macd_line_values[-1], signal_values[-1]

    return Indicators(
        ma_5=round(sum(closes[-5:]) / 5, 4),
        ma_20=round(sum(closes[-20:]) / 20, 4),
        macd=Macd(line=round(line, 4), signal=round(signal, 4), histogram=round((line - signal) * 2, 4)),
        rsi_14=_rsi(closes, 14),
        annualized_volatility=round(pstdev(returns) * sqrt(252), 4),
        max_drawdown=round(max_drawdown, 4),
        volume_ratio_5_to_20=round(
            (sum(volumes[-5:]) / 5) / (sum(volumes[-20:]) / 20), 4,
        ),
    )


def _ema(values: List[float], period: int) -> List[float]:
    result = [values[0]]
    multiplier = 2 / (period + 1)
    for value in values[1:]:
        result.append(value * multiplier + result[-1] * (1 - multiplier))
    return result


def _rsi(closes: List[float], period: int) -> float:
    changes = [closes[index] - closes[index - 1] for index in range(1, len(closes))]
    recent = changes[-period:]
    average_gain = sum(max(change, 0) for change in recent) / period
    average_loss = sum(max(-change, 0) for change in recent) / period
    if average_loss == 0:
        return 100.0
    strength = average_gain / average_loss
    return round(100 - 100 / (1 + strength), 2)
