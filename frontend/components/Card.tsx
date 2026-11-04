import { Banner } from "@/components/ui/Banner";
import { Button as UiButton, type ButtonProps } from "@/components/ui/Button";

export function Card({
  step,
  title,
  done,
  disabled,
  children,
}: {
  step: number;
  title: string;
  done?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border p-5 transition-opacity ${
        disabled
          ? "border-line opacity-50"
          : "border-line"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
            done
              ? "bg-success text-app"
              : "bg-hover text-ink"
          }`}
        >
          {done ? "✓" : step}
        </span>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className={disabled ? "pointer-events-none" : ""}>{children}</div>
    </section>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return <Banner tone="danger" className="mt-2">{message}</Banner>;
}

// Primary action. Defaults to type="submit" like the plain button it replaces, so callers inside forms keep working.
export function Button({ type = "submit", ...props }: ButtonProps) {
  return <UiButton variant="primary" type={type} {...props} />;
}
