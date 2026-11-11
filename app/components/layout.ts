/**
 * The app's responsive grid vocabulary, in one place.
 *
 * Polaris web components express responsiveness as a CONTAINER query inside the
 * attribute value, not as a breakpoint object:
 *   "@container <query> <value>, <fallback value>"
 *
 * Two things follow from that, and both matter on a phone:
 *
 *  1. `s-grid` measures ITS OWN container, not the viewport. A grid nested two
 *     sections deep sees a much smaller width than the screen, so breakpoints
 *     have to be chosen against the space the grid actually occupies.
 *  2. A grid written as a bare "2fr 1fr" has no query at all and therefore
 *     NEVER stacks. That is a mobile bug, not a style choice, and it is why
 *     every multi-column grid in this app uses one of the constants below.
 *
 * Embedded apps are used inside the Shopify mobile app as well as the desktop
 * admin, so "does it stack" is a real merchant-facing question.
 */

/** Main content beside a narrower sidebar. Stacks to one column on tablet. */
export const MAIN_WITH_SIDEBAR = "@container (inline-size <= 768px) 1fr, 2fr 1fr";

/** Two equal columns, e.g. a pair of form fields. Stacks on phones. */
export const TWO_UP = "@container (inline-size <= 560px) 1fr, 1fr 1fr";

/** Three equal columns, e.g. the impact stats. Stacks on phones. */
export const THREE_UP = "@container (inline-size <= 700px) 1fr, 1fr 1fr 1fr";

/**
 * Four equal columns, e.g. a row of scope choices. Two up below 700px rather
 * than fully stacked, because four short buttons stacked one per line pushes
 * the rest of the screen off a phone.
 */
export const FOUR_UP = "@container (inline-size <= 700px) 1fr 1fr, 1fr 1fr 1fr 1fr";

/**
 * A fixed 3x3 arrangement that must NOT collapse: the watermark position
 * picker only makes sense as a 3x3 grid, because its layout IS the meaning.
 */
export const FIXED_3X3 = "1fr 1fr 1fr";
