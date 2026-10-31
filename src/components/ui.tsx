"use client";

import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "accent" | "secondary" | "danger"; size?: "md" | "lg" };

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  const tone = {
    primary: "bg-ink text-white hover:bg-[oklch(0.3_0_0)]",
    accent: "bg-amber text-amber-ink hover:brightness-95",
    secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-2",
    danger: "border border-bad bg-surface text-bad hover:bg-bad-soft",
  }[variant];
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[13px] px-5 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "lg" ? "min-h-14 text-lg" : "min-h-11 text-base",
        tone,
        className,
      )}
      {...rest}
    />
  );
}

export function LinkButton({ href, children, variant = "primary", className }: { href: string; children: ReactNode; variant?: ButtonProps["variant"]; className?: string }) {
  const tone = variant === "secondary" ? "border border-line-strong bg-surface text-ink hover:bg-surface-2" : variant === "accent" ? "bg-amber text-amber-ink" : "bg-ink text-white hover:bg-[oklch(0.3_0_0)]";
  return (
    <a href={href} className={cx("inline-flex min-h-11 items-center justify-center rounded-[13px] px-5 text-base font-semibold transition", tone, className)}>
      {children}
    </a>
  );
}

const controlClass =
  "w-full rounded-[13px] border border-line-strong bg-surface px-3.5 text-base text-ink placeholder:text-muted/70 disabled:opacity-60";

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-sm text-muted">{hint}</p> : null}
      {error ? (
        <p className="text-sm font-medium text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ label, hint, error, id, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null }) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fieldId}>
      <input id={fieldId} aria-invalid={error ? true : undefined} className={cx(controlClass, "min-h-12", error && "border-bad", className)} {...rest} />
    </Field>
  );
}

export function Textarea({ label, hint, error, id, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string | null }) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fieldId}>
      <textarea id={fieldId} aria-invalid={error ? true : undefined} className={cx(controlClass, "min-h-24 py-3", error && "border-bad", className)} {...rest} />
    </Field>
  );
}

export function Card({ children, className, as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" | "li" } & Record<string, unknown>) {
  return (
    <Tag className={cx("rounded-[18px] border border-line bg-surface p-4 sm:p-5", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "bad" | "amber" }) {
  const toneClass = {
    neutral: "bg-surface-2 text-muted border-line",
    good: "bg-good-soft text-good border-good/30",
    bad: "bg-bad-soft text-bad border-bad/30",
    amber: "bg-amber-soft text-amber-ink border-amber/40",
  }[tone];
  return <span className={cx("inline-flex items-center rounded-full border px-2.5 py-0.5 text-sm font-semibold", toneClass)}>{children}</span>;
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[18px] border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
      <h2 className="text-xl font-semibold">{title}</h2>
      {body ? <p className="max-w-md text-base text-muted">{body}</p> : null}
      {action}
    </div>
  );
}

export function Banner({ tone = "bad", children, action }: { tone?: "bad" | "amber" | "good" | "neutral"; children: ReactNode; action?: ReactNode }) {
  const toneClass = {
    bad: "border-bad/40 bg-bad-soft text-bad",
    amber: "border-amber/50 bg-amber-soft text-amber-ink",
    good: "border-good/40 bg-good-soft text-good",
    neutral: "border-line bg-surface-2 text-ink",
  }[tone];
  return (
    <div className={cx("flex flex-wrap items-center justify-between gap-3 rounded-[13px] border px-4 py-3", toneClass)} role={tone === "bad" ? "alert" : "status"}>
      <div className="min-w-0 flex-1 text-base">{children}</div>
      {action}
    </div>
  );
}

export function SegmentedTabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (next: T) => void; options: Array<{ id: T; label: string }>; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="grid gap-1 rounded-[13px] border border-line bg-surface p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          id={`tab-${option.id}`}
          aria-selected={value === option.id}
          aria-controls={`panel-${option.id}`}
          onClick={() => onChange(option.id)}
          className={cx("min-h-11 rounded-[10px] px-3 text-base font-semibold transition", value === option.id ? "bg-ink text-white" : "text-muted hover:bg-surface-2")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-base text-muted">{subtitle}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-3 text-base text-muted" role="status">
      <span className="think-ring inline-block h-5 w-5 rounded-full border-2 border-dashed border-muted" aria-hidden="true" />
      {label}
    </p>
  );
}
