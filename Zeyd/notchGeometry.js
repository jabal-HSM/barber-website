// Shape of the floating notch bottom bar: a dark panel whose top edge rises in a smooth bump around the
// active tab. All values in CSS pixels; the bar is redrawn with these paths while the bump moves.

export const NOTCH = {
    rise: 24, // height of the bump above the flat top edge
    half: 50, // half width of the bump at its feet
    radius: 26, // top corners of the panel
};

const round = (n) => Math.round(n * 10) / 10;

// The bump's feet are kept clear of the rounded corners, so at the first and last tab the bump is a little
// narrower on the outer side instead of breaking the corner.
function feet(width, cx) {
    const min = NOTCH.radius;
    const max = width - NOTCH.radius;
    const center = Math.min(Math.max(cx, min + 8), max - 8);
    return { left: Math.max(center - NOTCH.half, min), center, right: Math.min(center + NOTCH.half, max) };
}

function topEdge(width, cx) {
    const { rise, radius } = NOTCH;
    const { left, center, right } = feet(width, cx);
    const k = 0.55; // bezier handles: round shoulders, rounded top
    return [
        `L${round(left)} ${rise}`,
        `C${round(left + (center - left) * k)} ${rise} ${round(center - (center - left) * k)} 0 ${round(center)} 0`,
        `C${round(center + (right - center) * k)} 0 ${round(right - (right - center) * k)} ${rise} ${round(right)} ${rise}`,
        `L${round(width - radius)} ${rise}`,
    ].join(' ');
}

// Filled panel, from the top edge down to the bottom of the screen
export function barPath(width, height, cx) {
    const { rise, radius } = NOTCH;
    return [
        `M0 ${rise + radius}`,
        `Q0 ${rise} ${radius} ${rise}`,
        topEdge(width, cx),
        `Q${width} ${rise} ${width} ${rise + radius}`,
        `L${width} ${height}`,
        `L0 ${height}`,
        'Z',
    ].join(' ');
}

// Glowing line along the top edge only
export function edgePath(width, cx) {
    const { rise, radius } = NOTCH;
    return [
        `M0 ${rise + radius}`,
        `Q0 ${rise} ${radius} ${rise}`,
        topEdge(width, cx),
        `Q${width} ${rise} ${width} ${rise + radius}`,
    ].join(' ');
}

// Smooth, quick, no overshoot
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
