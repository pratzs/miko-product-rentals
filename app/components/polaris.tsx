import { useEffect, useRef, type ComponentProps, type ElementRef, type ReactNode, type RefObject } from "react";

/**
 * Thin React 18 adapter over Polaris WEB COMPONENTS (`s-*`).
 *
 * Why this layer exists at all, rather than writing `s-*` tags directly:
 *
 *  1. **React 18 has no custom-element support.** Property and custom-event
 *     binding for custom elements landed in React 19. Under 18, `onClick` and
 *     `onInput` happen to work (React delegates those native events on any
 *     element), but Polaris's own events - `dismiss`, `afterhide`, `nextpage`,
 *     `previouspage`, `droprejected` - never fire from an `onX` prop. They are
 *     wired here with addEventListener instead.
 *  2. **Boolean attributes are a trap.** React 18 renders `disabled={false}` on
 *     an unknown element as the literal attribute `disabled="false"`, and HTML
 *     treats any present `disabled` attribute as disabled. Every boolean goes
 *     through `flag()`, which returns undefined instead of false.
 *  3. **Polaris ships no range slider.** Built here from a native input so the
 *     rest of the app imports it like any other component. (Polaris 2.0 added
 *     `s-progress`, so ProgressBar is now a thin wrapper over it.)
 *
 * When this app moves to React 19 (or React Router 7), points 1 and 2 stop
 * being true and these wrappers can collapse into plain tags. That is the whole
 * reason the adapter is one file: the migration is contained.
 */

/** A boolean attribute must be absent, never "false". */
export function flag(on: boolean | undefined): true | undefined {
  return on ? true : undefined;
}

/**
 * Bind a Polaris custom event. React 18 cannot, so anything not in React's
 * delegated native-event set has to be attached by hand.
 * Event names are lowercase and unprefixed: "dismiss", not "onDismiss".
 */
export function useCustomEvent<T extends HTMLElement = HTMLElement>(
  ref: RefObject<T | null>,
  event: string,
  handler: ((e: Event & { currentTarget: T }) => void) | undefined,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !handler) return;
    const fn = (e: Event) => handler(e as Event & { currentTarget: T });
    el.addEventListener(event, fn);
    return () => el.removeEventListener(event, fn);
  }, [ref, event, handler]);
}

// ─── Missing components, rebuilt on Polaris primitives ──────────────────────

/**
 * Progress bar on Polaris 2's own `s-progress` (added in 2.0). Kept as a
 * wrapper so call sites pass a 0-100 percentage the way Polaris React's
 * ProgressBar took it. Omitting the value makes it indeterminate.
 */
export function ProgressBar({
  progress,
  label,
  indeterminate,
  tone,
}: {
  progress: number;
  label?: string;
  indeterminate?: boolean;
  tone?: ComponentProps<"s-progress">["tone"];
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <s-progress
      max={100}
      value={indeterminate ? undefined : pct}
      tone={tone}
      accessibilityLabel={label ?? (indeterminate ? "Working" : `${pct}% complete`)}
    />
  );
}

/**
 * Range slider. Polaris has no equivalent, so this is a native input styled to
 * sit correctly beside Polaris fields. `onInput` is used rather than `onChange`
 * so the value tracks the drag rather than only landing on release.
 */
export function RangeSlider({
  label,
  min,
  max,
  step = 1,
  value,
  disabled,
  helpText,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  disabled?: boolean;
  helpText?: string;
  onChange: (v: number) => void;
}) {
  return (
    <s-stack direction="block" gap="small-100">
      <s-text>{label}</s-text>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        style={{ width: "100%", accentColor: "currentColor", cursor: disabled ? "default" : "pointer" }}
      />
      {helpText ? (
        <s-text tone="neutral" color="subdued">
          {helpText}
        </s-text>
      ) : null}
    </s-stack>
  );
}

/**
 * A responsive grid.
 *
 * `s-grid`'s `@container (...)` value only resolves if an ancestor actually
 * ESTABLISHES a container query context, and `s-page`/`s-section` do not. A
 * bare `s-grid` with a container query silently falls back to its multi-column
 * value at every width, which on a phone means nothing ever stacks. Verified
 * against the real CDN build: at a 343px-wide grid, an unwrapped
 * "@container (inline-size <= 768px) 1fr, 2fr 1fr" still resolved to two
 * columns, while the identical grid inside `s-query-container` stacked.
 *
 * So every responsive grid goes through here and gets the wrapper. Use a plain
 * `s-grid` only for a fixed column count that must never collapse.
 */
export function Grid({
  columns,
  gap,
  children,
}: {
  columns: string;
  // Borrowed straight from the element so the spacing vocabulary cannot drift.
  gap?: ComponentProps<"s-grid">["gap"];
  children: ReactNode;
}) {
  return (
    <s-query-container>
      <s-grid gridTemplateColumns={columns} gap={gap}>
        {children}
      </s-grid>
    </s-query-container>
  );
}

// ─── Wrappers for the interactive components ────────────────────────────────

/**
 * Button whose click is bound with addEventListener rather than React's `onClick`.
 *
 * React 18 delegates synthetic events from its root, which works for a plain
 * `s-button` on a page but proved unreliable for one rendered inside
 * `s-table`: on a phone the table re-renders as a list and a View control
 * simply did nothing when tapped. Binding the listener directly to the element
 * removes the dependency on delegation surviving the table's own rendering.
 *
 * Use this for any button inside a table. Elsewhere a plain `s-button` is fine.
 */
export function Button({
  children,
  onClick,
  variant,
  tone,
  loading,
  disabled,
  inlineSize,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary" | "tertiary" | "auto";
  tone?: "auto" | "neutral" | "critical";
  loading?: boolean;
  disabled?: boolean;
  inlineSize?: ComponentProps<"s-button">["inlineSize"];
}) {
  const ref = useRef<ElementRef<"s-button">>(null);
  useCustomEvent(ref, "click", () => onClick());
  return (
    <s-button
      ref={ref}
      variant={variant}
      tone={tone}
      inlineSize={inlineSize}
      loading={flag(loading)}
      disabled={flag(disabled)}
    >
      {children}
    </s-button>
  );
}

/**
 * Text, number, email, URL, date, money-free numeric and multi-line fields
 * behind one controlled API (the shape Polaris React's TextField had), so
 * route code keeps `value` + `onChange(string)`. `input` fires per keystroke;
 * the value lives on the target. Fields never get a `name`: every form in this
 * app submits through hidden inputs that mirror React state, so a named
 * custom element would double-submit.
 */
export function TextField({
  label,
  value,
  onChange,
  onBlur,
  details,
  error,
  type,
  multiline,
  suffix,
  prefix,
  placeholder,
  id,
  disabled,
  readOnly,
  required,
  labelHidden,
  min,
  max,
  step,
  maxLength,
  autoComplete,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  onBlur?: () => void;
  details?: string;
  error?: string;
  type?: "text" | "number" | "email" | "url" | "date";
  /** Truthy renders `s-text-area`; a number sets its rows. */
  multiline?: boolean | number;
  suffix?: string;
  prefix?: string;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  labelHidden?: boolean;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  autoComplete?: string;
}) {
  // One ref typed loosely: it lands on whichever field element renders.
  const ref = useRef<HTMLElement>(null);
  useCustomEvent(ref, "input", (e) => {
    onChange(String((e.currentTarget as unknown as { value?: string }).value ?? ""));
  });
  // date-field commits on change rather than input.
  useCustomEvent(ref, "change", type === "date" ? (e) => {
    onChange(String((e.currentTarget as unknown as { value?: string }).value ?? ""));
  } : undefined);
  useCustomEvent(ref, "blur", onBlur ? () => onBlur() : undefined);
  const shared = {
    id,
    label,
    value: value == null ? "" : String(value),
    details,
    error,
    placeholder,
    disabled: flag(disabled),
    readOnly: flag(readOnly),
    required: flag(required),
    labelAccessibilityVisibility: labelHidden ? ("exclusive" as const) : undefined,
    autocomplete: autoComplete as never,
  };
  const anyRef = ref as never;
  if (multiline) {
    return (
      <s-text-area
        ref={anyRef}
        {...shared}
        rows={typeof multiline === "number" ? multiline : 3}
        maxLength={maxLength}
      />
    );
  }
  if (type === "number") {
    return (
      <s-number-field
        ref={anyRef}
        {...shared}
        min={min}
        max={max}
        step={step}
        prefix={prefix}
        suffix={suffix}
      />
    );
  }
  if (type === "email") {
    return <s-email-field ref={anyRef} {...shared} maxLength={maxLength} />;
  }
  if (type === "url") {
    return <s-url-field ref={anyRef} {...shared} maxLength={maxLength} />;
  }
  if (type === "date") {
    return <s-date-field ref={anyRef} {...shared} />;
  }
  return (
    <s-text-field
      ref={anyRef}
      {...shared}
      prefix={prefix}
      suffix={suffix}
      maxLength={maxLength}
    />
  );
}

/** Select. Options are child elements, not an attribute. */
export function Select({
  label,
  value,
  options,
  onChange,
  details,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (v: string) => void;
  details?: string;
  disabled?: boolean;
}) {
  const ref = useRef<ElementRef<"s-select">>(null);
  // React 18 only writes the `value` attribute on custom elements, and it lands
  // before the options exist, so the select can show its first option instead of
  // the saved one. Set the live property after render; skipped when it matches.
  useEffect(() => {
    const el = ref.current as unknown as { value?: string } | null;
    if (el && value !== undefined && el.value !== String(value)) el.value = String(value);
  }, [ref, value]);
  useCustomEvent(ref, "change", (e) => {
    onChange(String((e.currentTarget as unknown as { value?: string }).value ?? ""));
  });
  return (
    <s-select ref={ref} label={label} value={value} details={details} disabled={flag(disabled)}>
      {options.map((o) => (
        <s-option key={o.value} value={o.value}>
          {o.label}
        </s-option>
      ))}
    </s-select>
  );
}

/** Checkbox. The new state is on the target, not the event. */
export function Checkbox({
  label,
  checked,
  onChange,
  details,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  details?: string;
  disabled?: boolean;
}) {
  const ref = useRef<ElementRef<"s-checkbox">>(null);
  useCustomEvent(ref, "change", (e) => {
    onChange(Boolean((e.currentTarget as unknown as { checked?: boolean }).checked));
  });
  return (
    <s-checkbox
      ref={ref}
      label={label}
      details={details}
      checked={flag(checked)}
      disabled={flag(disabled)}
    />
  );
}

/** A banner button: an in-app action, or a link when `url` is set. */
export type BannerAction = {
  content: string;
  onAction?: () => void;
  url?: string;
  /** Open `url` in a new tab (App Store, docs, Shopify admin pages). */
  external?: boolean;
  loading?: boolean;
  disabled?: boolean;
};

/**
 * Banner. `dismiss` is a Polaris event, so React 18 needs a ref.
 * Polaris web components give a banner a single `secondary-actions` slot for
 * up to two buttons, so Polaris React's `action` and `secondaryAction` both
 * land there, in that order. In-app urls must be navigated by the caller
 * (pass `onAction` with Remix's navigate); `url` here is for external links.
 */
export function Banner({
  tone,
  heading,
  title,
  children,
  onDismiss,
  action,
  secondaryAction,
}: {
  tone?: "info" | "success" | "warning" | "critical" | "auto";
  heading?: string;
  /** Polaris React's name for `heading`, accepted so call sites read the same. */
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  action?: BannerAction;
  secondaryAction?: BannerAction;
}) {
  const ref = useRef<ElementRef<"s-banner">>(null);
  useCustomEvent(ref, "dismiss", onDismiss ? () => onDismiss() : undefined);
  return (
    <s-banner
      ref={ref}
      tone={tone ?? "auto"}
      heading={heading ?? title}
      dismissible={flag(!!onDismiss)}
    >
      {children}
      {[action, secondaryAction].filter(Boolean).map((a, i) => (
        <s-button
          key={i}
          slot="secondary-actions"
          href={a!.url}
          target={a!.url && a!.external ? "_blank" : undefined}
          loading={flag(a!.loading)}
          disabled={flag(a!.disabled)}
          onClick={a!.onAction ? () => a!.onAction!() : undefined}
        >
          {a!.content}
        </s-button>
      ))}
    </s-banner>
  );
}

/**
 * Modal driven from React state. Polaris opens modals declaratively via
 * `commandFor`, but the element also exposes showOverlay()/hideOverlay(), which
 * is what lets an app keep its existing state-driven confirm flows.
 */
export function Modal({
  id,
  open,
  heading,
  children,
  onClose,
  primaryAction,
  secondaryAction,
}: {
  id: string;
  open: boolean;
  heading: string;
  children: ReactNode;
  onClose: () => void;
  primaryAction?: { content: string; onAction: () => void; disabled?: boolean };
  secondaryAction?: { content: string };
}) {
  const ref = useRef<ElementRef<"s-modal">>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) el.showOverlay?.();
    else el.hideOverlay?.();
  }, [open]);

  // The merchant can dismiss with Escape or the close button, which React does
  // not know about; without this the state would say "open" while it is shut.
  useCustomEvent(ref, "afterhide", () => {
    if (open) onClose();
  });

  return (
    <s-modal ref={ref} id={id} heading={heading}>
      {children}
      <s-button slot="secondary-actions" onClick={onClose}>
        {secondaryAction?.content ?? "Cancel"}
      </s-button>
      {primaryAction ? (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={flag(primaryAction.disabled)}
          onClick={primaryAction.onAction}
        >
          {primaryAction.content}
        </s-button>
      ) : null}
    </s-modal>
  );
}

/** Drop zone. Files and rejections both arrive as custom events. */
export function DropZone({
  label,
  accept,
  onDrop,
  onReject,
  children,
}: {
  label: string;
  accept?: string;
  onDrop: (files: File[]) => void;
  onReject?: () => void;
  children?: ReactNode;
}) {
  const ref = useRef<ElementRef<"s-drop-zone">>(null);
  useCustomEvent(ref, "change", (e) => {
    const files = (e.currentTarget as unknown as { files?: File[] }).files ?? [];
    if (files.length) onDrop(Array.from(files));
  });
  useCustomEvent(ref, "droprejected", onReject ? () => onReject() : undefined);
  return (
    <s-drop-zone ref={ref} label={label} accept={accept}>
      {children}
    </s-drop-zone>
  );
}

// ─── Mapping helpers for the Polaris React rewrite ───────────────────────────

/**
 * Polaris React badge/banner tones mapped onto the web component vocabulary.
 * `attention` became `caution`; `new`, `magic` and the `*-strong` variants
 * have no equivalent and fall back to the nearest neutral meaning.
 */
export type BadgeTone = ComponentProps<"s-badge">["tone"];
export function badgeTone(tone: string | undefined): BadgeTone {
  switch (tone) {
    case "success":
    case "success-strong":
      return "success";
    case "attention":
    case "attention-strong":
      return "caution";
    case "warning":
    case "warning-strong":
      return "warning";
    case "critical":
    case "critical-strong":
      return "critical";
    case "info":
    case "info-strong":
      return "info";
    case "new":
    case "magic":
    case "read-only":
    case "enabled":
      return "neutral";
    default:
      return "auto";
  }
}

/**
 * In-app link. Polaris React's `url` props went through the Remix link
 * component (client-side navigation); `s-link` alone would do a full document
 * load inside the iframe. The href is kept so it still reads as a link and
 * opens in a new tab on cmd/ctrl-click.
 */
export function AppLink({
  to,
  children,
  navigate,
  slot,
  tone,
}: {
  to: string;
  children: ReactNode;
  navigate: (to: string) => void;
  slot?: Lowercase<string>;
  tone?: ComponentProps<"s-link">["tone"];
}) {
  return (
    <s-link
      href={to}
      slot={slot}
      tone={tone}
      onClick={(e: { preventDefault: () => void; metaKey?: boolean; ctrlKey?: boolean }) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </s-link>
  );
}
