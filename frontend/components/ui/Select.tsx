"use client";

import React, {
  Children,
  forwardRef,
  isValidElement,
  useId,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
  subLabel?: ReactNode;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

export type SelectItem =
  | { type: "option"; data: SelectOption }
  | { type: "group"; data: SelectGroup };

export interface SelectChangeEvent {
  target: {
    value: string;
    name: string;
  };
  currentTarget: {
    value: string;
    name: string;
  };
  preventDefault(): void;
  stopPropagation(): void;
}

export interface SelectProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "defaultValue" | "value"
  > {
  id?: string;
  name?: string;
  value?: string | number | null;
  defaultValue?: string | number;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  options?: (SelectOption | SelectGroup)[];
  children?: ReactNode;
  onChange?: (event: SelectChangeEvent) => void;
  onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
}

function getOptionText(label: ReactNode): string {
  if (typeof label === "string") return label;
  if (typeof label === "number") return String(label);
  if (Array.isArray(label)) return label.map(getOptionText).join("");
  if (isValidElement(label)) return getOptionText((label.props as any)?.children);
  return "";
}

function parseItems(children: ReactNode): SelectItem[] {
  const items: SelectItem[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;

    const props = child.props as any;
    const isGroup =
      child.type === "optgroup" || (props?.label && props?.children);

    if (isGroup) {
      const groupOptions: SelectOption[] = [];
      Children.forEach(props.children, (subChild) => {
        if (!isValidElement(subChild)) return;
        const subProps = subChild.props as any;
        groupOptions.push({
          value: String(subProps.value ?? ""),
          label: subProps.children ?? subProps.label ?? String(subProps.value ?? ""),
          disabled: Boolean(subProps.disabled),
          className: subProps.className,
        });
      });
      items.push({
        type: "group",
        data: {
          label: String(props.label || ""),
          options: groupOptions,
        },
      });
    } else if (child.type === "option" || props?.value !== undefined) {
      items.push({
        type: "option",
        data: {
          value: String(props.value ?? ""),
          label: props.children ?? props.label ?? String(props.value ?? ""),
          disabled: Boolean(props.disabled),
          className: props.className,
        },
      });
    }
  });

  return items;
}

function normalizeOptions(
  options?: (SelectOption | SelectGroup)[],
  children?: ReactNode
): { items: SelectItem[]; flat: SelectOption[] } {
  let items: SelectItem[] = [];

  if (options && options.length > 0) {
    items = options.map((item) => {
      if ("options" in item && Array.isArray(item.options)) {
        return {
          type: "group",
          data: {
            label: item.label,
            options: item.options.map((opt) => ({
              ...opt,
              value: String(opt.value),
            })),
          },
        };
      }
      return {
        type: "option",
        data: {
          ...item,
          value: String((item as SelectOption).value),
        },
      };
    });
  } else if (children) {
    items = parseItems(children);
  }

  const flat: SelectOption[] = [];
  for (const item of items) {
    if (item.type === "group") {
      flat.push(...item.data.options);
    } else {
      flat.push(item.data);
    }
  }

  return { items, flat };
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  function Select(
    {
      id,
      name,
      value,
      defaultValue,
      placeholder,
      disabled = false,
      required,
      className,
      triggerClassName,
      menuClassName,
      "aria-label": ariaLabel,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      options,
      children,
      onChange,
      onBlur,
      onFocus,
      ...restProps
    },
    ref
  ) {
    const defaultId = useId();
    const selectId = id || defaultId;
    const [open, setOpen] = useState(false);

    const [uncontrolledValue, setUncontrolledValue] = useState<string>(
      defaultValue != null ? String(defaultValue) : ""
    );

    const isControlled = value !== undefined;
    const currentValue = isControlled
      ? value != null
        ? String(value)
        : ""
      : uncontrolledValue;

    const { items, flat } = normalizeOptions(options, children);

    const selectedOption = flat.find((opt) => opt.value === currentValue);

    const handleSelect = (val: string, optionDisabled?: boolean) => {
      if (optionDisabled || disabled) return;

      if (!isControlled) {
        setUncontrolledValue(val);
      }

      if (onChange) {
        const syntheticEvent: SelectChangeEvent = {
          target: { value: val, name: name || selectId },
          currentTarget: { value: val, name: name || selectId },
          preventDefault: () => {},
          stopPropagation: () => {},
        };
        onChange(syntheticEvent);
      }
      setOpen(false);
    };

    const displayText =
      selectedOption != null
        ? selectedOption.label
        : placeholder ?? (flat[0]?.label || "Select...");

    // Split container layout classes from button styling classes
    const classTokens = (className || "").split(/\s+/).filter(Boolean);
    const containerClasses = classTokens
      .filter((c: string) =>
        /^(?:m[trblxy]?-|w-auto|w-fit|w-36|w-48|w-56|w-64|min-w-|max-w-|flex-1|shrink-0|col-span-)/.test(
          c
        )
      )
      .join(" ");

    const isExplicitAuto = /\bw-(?:auto|fit|36|48|56|64)\b/.test(className || "");
    const isFlexGrow = /\bflex-1\b/.test(className || "");

    return (
      <div
        className={cn(
          "relative inline-flex",
          isFlexGrow ? "flex-1 min-w-0" : isExplicitAuto ? "w-auto max-w-full" : "w-full",
          containerClasses
        )}
      >
        {/* Hidden select for form submissions and screen readers */}
        <select
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          id={id ? `${id}-native` : undefined}
          required={required}
          value={currentValue}
          disabled={disabled}
          onChange={(e) => handleSelect(e.target.value)}
          className="sr-only pointer-events-none"
        >
          {flat.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {getOptionText(opt.label) || opt.value}
            </option>
          ))}
        </select>

        {/* Radix Dropdown Menu */}
        <RadixDropdown.Root open={open} onOpenChange={setOpen}>
          <RadixDropdown.Trigger asChild>
            <button
              ref={ref}
              type="button"
              id={selectId}
              disabled={disabled}
              aria-label={ariaLabel}
              aria-describedby={ariaDescribedBy}
              aria-invalid={ariaInvalid}
              onBlur={onBlur}
              onFocus={onFocus}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between gap-2 rounded-field border border-line bg-raised/70 px-3 py-2 text-left text-sm text-ink transition-all duration-150",
                "hover:border-ink/30 hover:bg-raised focus:outline-none focus:ring-1 focus:ring-accent",
                "disabled:cursor-not-allowed disabled:opacity-50",
                open && "border-accent ring-1 ring-accent bg-raised",
                className,
                triggerClassName
              )}
              {...restProps}
            >
              <span className="truncate flex-1">{displayText}</span>
              <ChevronDown
                size={14}
                className={cn(
                  "shrink-0 text-muted transition-transform duration-200",
                  open && "rotate-180 text-ink"
                )}
              />
            </button>
          </RadixDropdown.Trigger>

          <RadixDropdown.Portal>
            <RadixDropdown.Content
              align="start"
              sideOffset={4}
              collisionPadding={8}
              style={{
                minWidth: "var(--radix-dropdown-menu-trigger-width)",
                maxWidth: "max(var(--radix-dropdown-menu-trigger-width), 480px)",
              }}
              className={cn(
                "z-50 max-h-72 overflow-y-auto rounded-card border border-line bg-raised p-1 text-sm text-ink shadow-2xl animate-pop-in focus:outline-none",
                menuClassName
              )}
            >
              {items.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted">No options</div>
              ) : (
                items.map((item, idx) => {
                  if (item.type === "group") {
                    return (
                      <RadixDropdown.Group key={`group-${idx}`} className="py-1">
                        <RadixDropdown.Label className="px-2.5 py-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
                          {item.data.label}
                        </RadixDropdown.Label>
                        {item.data.options.map((opt) => {
                          const isSelected = opt.value === currentValue;
                          return (
                            <RadixDropdown.Item
                              key={opt.value}
                              disabled={opt.disabled}
                              onSelect={() => handleSelect(opt.value, opt.disabled)}
                              className={cn(
                                "flex cursor-pointer items-center justify-between gap-2 rounded-field px-2.5 py-1.5 text-sm outline-none transition-colors select-none",
                                "data-[highlighted]:bg-hover data-[highlighted]:text-ink",
                                opt.disabled &&
                                  "cursor-not-allowed opacity-40 data-[highlighted]:bg-transparent data-[highlighted]:text-muted",
                                isSelected &&
                                  "bg-accent/15 font-medium text-accent data-[highlighted]:bg-accent/25",
                                opt.className
                              )}
                            >
                              <span className="truncate flex-1">{opt.label}</span>
                              {isSelected && (
                                <Check size={14} className="shrink-0 text-accent" />
                              )}
                            </RadixDropdown.Item>
                          );
                        })}
                      </RadixDropdown.Group>
                    );
                  }

                  const opt = item.data;
                  const isSelected = opt.value === currentValue;
                  return (
                    <RadixDropdown.Item
                      key={opt.value}
                      disabled={opt.disabled}
                      onSelect={() => handleSelect(opt.value, opt.disabled)}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-2 rounded-field px-2.5 py-1.5 text-sm outline-none transition-colors select-none",
                        "data-[highlighted]:bg-hover data-[highlighted]:text-ink",
                        opt.disabled &&
                          "cursor-not-allowed opacity-40 data-[highlighted]:bg-transparent data-[highlighted]:text-muted",
                        isSelected &&
                          "bg-accent/15 font-medium text-accent data-[highlighted]:bg-accent/25",
                        opt.className
                      )}
                    >
                      <span className="truncate flex-1">{opt.label}</span>
                      {isSelected && (
                        <Check size={14} className="shrink-0 text-accent" />
                      )}
                    </RadixDropdown.Item>
                  );
                })
              )}
            </RadixDropdown.Content>
          </RadixDropdown.Portal>
        </RadixDropdown.Root>
      </div>
    );
  }
);

export function Option(props: React.OptionHTMLAttributes<HTMLOptionElement>) {
  return <option {...props} />;
}

export function OptGroup(
  props: React.OptgroupHTMLAttributes<HTMLOptGroupElement>
) {
  return <optgroup {...props} />;
}

export { Select as CustomSelect };
