"""Compare executable key curves, not the positions of authored key records.

The runtime supports piecewise constant, linear and cubic smoothstep curves.
Four distinct interior values exactly determine each degree <= 3 interval.
Fraction arithmetic avoids declaring small real changes equal by tolerance.
Unsupported/ambiguous tracks conservatively reopen the complete timeline.
"""
from bisect import bisect_right
from fractions import Fraction
import math


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _prepare(keys, duration):
    if not keys:
        raise ValueError('Missing curve')
    times = []
    values = []
    modes = []
    shape = None
    for key in keys:
        time = key.get('time')
        value = key.get('value')
        mode = key.get('interpolation')
        if not _number(time) or not 0 <= time <= duration or times and time <= times[-1]:
            raise ValueError('Invalid or duplicate key time')
        if mode not in (None, 'linear', 'smooth', 'step'):
            raise ValueError('Unsupported interpolation')
        if type(value) is bool:
            current_shape = ('bool', 1)
            cooked = value
        elif _number(value):
            current_shape = ('numeric', 1)
            cooked = (Fraction(value),)
        elif isinstance(value, list) and value and all(_number(v) for v in value):
            current_shape = ('vector', len(value))
            cooked = tuple(Fraction(v) for v in value)
        else:
            raise ValueError('Unsupported value')
        if shape is not None and shape != current_shape:
            raise ValueError('Inconsistent values')
        shape = current_shape
        times.append(Fraction(time))
        values.append(cooked)
        modes.append(mode)
    return times, values, modes


def _value(curve, time):
    times, values, modes = curve
    if time <= times[0]:
        return values[0]
    i = bisect_right(times, time) - 1
    a = values[i]
    if i == len(times) - 1 or modes[i] == 'step' or type(a) is bool:
        return a
    u = (time - times[i]) / (times[i + 1] - times[i])
    if modes[i] == 'smooth':
        u = u * u * (3 - 2 * u)
    return tuple(x + (y - x) * u for x, y in zip(a, values[i + 1]))


def changed_curve_intervals(old_keys, new_keys, duration):
    """Closed conservative intervals where the runtime's sampled values differ.

    This is an algebraic equality test of the supported curves, not sparse
    visual sampling. Closed ends deliberately retain neighboring boundary shots.
    Quaternion normalization and downstream object dependencies may reduce actual
    differences, never increase them beyond these raw curve intervals.
    """
    try:
        old = _prepare(old_keys, duration)
        new = _prepare(new_keys, duration)
        boundaries = sorted({Fraction(0), Fraction(duration), *old[0], *new[0]})
        changed = [(t, t) for t in boundaries if _value(old, t) != _value(new, t)]
        for left, right in zip(boundaries, boundaries[1:]):
            if any(_value(old, left + (right - left) * Fraction(n, 5)) !=
                   _value(new, left + (right - left) * Fraction(n, 5)) for n in (1, 2, 3, 4)):
                changed.append((left, right))
        merged = []
        for left, right in sorted(changed):
            if merged and left <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(right, merged[-1][1]))
            else:
                merged.append((left, right))
        return [(float(a), float(b)) for a, b in merged]
    except (ValueError, TypeError, KeyError, OverflowError):
        return [(0, duration)]
