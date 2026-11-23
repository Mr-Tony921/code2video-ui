"""Deterministic evidence for coarse previs, never a semantic pass shortcut."""
import math

CONTACT_POLICY = 'coarse-contact-v1'


def contact_tolerance(box_a, box_b):
    """Meters: 5% of the smaller object's maximum extent, capped at 2 cm.

    Bounds are measured opaque world geometry, not names or authored intent.
    Unknown bounds give no tolerance evidence; tiny objects keep a small limit.
    """
    extents = []
    for box in (box_a, box_b):
        if not isinstance(box, list) or len(box) != 2:
            return None
        if any(not isinstance(p, list) or len(p) != 3 for p in box):
            return None
        if any(type(v) not in (int, float) or not math.isfinite(v) for p in box for v in p):
            return None
        sides = [box[1][i] - box[0][i] for i in range(3)]
        if min(sides) < 0 or max(sides) <= 0:
            return None
        extents.append(max(sides))
    return min(0.02, 0.05 * min(extents))


def review_entities(project):
    """Expose actual registered parent IDs; binding alone never proves contact."""
    ids = {e['uuid']: e['id'] for e in project['entities']}
    rows = []
    for entity in project['entities']:
        row = {k: v for k, v in entity.items() if k not in ('uuid', 'parent')}
        parent_id = ids.get(entity.get('parent'))
        if parent_id is not None:
            row['parent_id'] = parent_id
        rows.append(row)
    return rows
