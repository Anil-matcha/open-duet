import { useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Switch, View, type TextInputProps } from 'react-native';

import { Text, TextInput } from '@/components/text';
import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';

// The few controls the agent and room forms are made of, in the app's own theme and with 44 point touch targets.

/** A label above a control, with an optional note, a counter and an error. Reads as one group to a screen reader. */
export function Field({ label, helper, error, counter, children }: { label: string; helper?: string; error?: string | null; counter?: string; children: ReactNode }) {
  const styles = useStyles(createStyles);
  return (
    <View style={styles.field}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {counter ? <Text style={styles.counter}>{counter}</Text> : null}
      </View>
      {children}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : helper ? (
        <Text style={styles.helper}>{helper}</Text>
      ) : null}
    </View>
  );
}

/** A text box. `lines` above 1 makes it a taller, multi-line box. */
export function FormInput({ lines = 1, invalid, ...props }: TextInputProps & { lines?: number; invalid?: boolean }) {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.muted}
      multiline={lines > 1}
      underlineColorAndroid="transparent"
      textAlignVertical={lines > 1 ? 'top' : 'center'}
      {...props}
      style={[styles.input, lines > 1 && { minHeight: 24 * lines + 20 }, invalid && styles.invalid, props.style]}
    />
  );
}

export function SectionTitle({ children }: { children: string }) {
  const styles = useStyles(createStyles);
  return (
    <Text accessibilityRole="header" style={styles.section}>
      {children}
    </Text>
  );
}

/** A switch with its label and an optional note. The whole row is the target. */
export function SwitchRow({ label, helper, value, onValueChange }: { label: string; helper?: string; value: boolean; onValueChange: (value: boolean) => void }) {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }} style={styles.switchRow} onPress={() => onValueChange(!value)}>
      <View style={styles.switchText}>
        <Text style={styles.optionLabel}>{label}</Text>
        {helper ? <Text style={styles.helper}>{helper}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: theme.accent, false: theme.border }} thumbColor={theme.onAccent} accessible={false} />
    </Pressable>
  );
}

export type Option<T extends string> = { value: T; label: string; description?: string; disabled?: boolean; note?: string | null };

/** One choice out of a few, each with its explanation (how an agent asks before it acts). */
export function RadioGroup<T extends string>({ label, options, value, onChange }: { label: string; options: Option<T>[]; value: T; onChange: (value: T) => void }) {
  const styles = useStyles(createStyles);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.group}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={option.note ?? option.description}
            accessibilityState={{ selected, disabled: option.disabled }}
            disabled={option.disabled}
            style={({ pressed }) => [styles.radio, selected && styles.radioSelected, pressed && styles.pressed, option.disabled && styles.disabled]}
            onPress={() => onChange(option.value)}
          >
            <View style={[styles.dot, selected && styles.dotSelected]}>{selected ? <View style={styles.dotInner} /> : null}</View>
            <View style={styles.switchText}>
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.note ? <Text style={styles.note}>{option.note}</Text> : option.description ? <Text style={styles.helper}>{option.description}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A row that opens a list of choices in a sheet from the bottom of the screen, and shows the one chosen. */
export function PickerField<T extends string>({
  label,
  title,
  valueLabel,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  title: string;
  valueLabel: string;
  options: Option<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${valueLabel}`}
        accessibilityHint="Opens a list to choose from"
        disabled={disabled}
        style={({ pressed }) => [styles.picker, pressed && styles.pressed, disabled && styles.disabled]}
        onPress={() => setOpen(true)}
      >
        <Text style={styles.pickerValue} numberOfLines={1}>
          {valueLabel}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={() => setOpen(false)} />
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.sheetTitle}>
            {title}
          </Text>
          <FlatList
            data={options}
            keyExtractor={(option) => option.value}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityHint={item.note ?? undefined}
                accessibilityState={{ selected: item.value === value, disabled: item.disabled }}
                disabled={item.disabled}
                style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed, item.disabled && styles.disabled]}
                onPress={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
              >
                <View style={styles.switchText}>
                  <Text style={styles.optionLabel}>{item.label}</Text>
                  {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
                </View>
                {item.value === value ? <Text style={{ color: theme.accentText }}>✓</Text> : null}
              </Pressable>
            )}
          />
          <Button label="Cancel" kind="secondary" onPress={() => setOpen(false)} />
        </View>
      </Modal>
    </>
  );
}

export type SheetAction = { label: string; onPress: () => void };

/** A list of actions in a sheet from the bottom of the screen. Alert.alert shows only three buttons on Android, so a menu of more is made here. */
export function ActionSheet({ title, actions, onClose }: { title: string; actions: SheetAction[] | null; onClose: () => void }) {
  const styles = useStyles(createStyles);
  return (
    <Modal visible={actions !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet} accessibilityViewIsModal>
        <Text accessibilityRole="header" style={styles.sheetTitle}>
          {title}
        </Text>
        {(actions ?? []).map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
            onPress={() => {
              onClose();
              action.onPress();
            }}
          >
            <Text style={styles.optionLabel}>{action.label}</Text>
          </Pressable>
        ))}
        <Button label="Cancel" kind="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

/** `spoken` is what a screen reader says when it should say more than the words on the button ("Hold" for which member). */
export function Button({ label, spoken, onPress, kind = 'primary', busy, disabled }: { label: string; spoken?: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; busy?: boolean; disabled?: boolean }) {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      style={({ pressed }) => [styles.button, kind === 'primary' ? styles.buttonPrimary : kind === 'danger' ? styles.buttonDanger : styles.buttonSecondary, pressed && styles.pressed, off && styles.disabled]}
      onPress={onPress}
    >
      {busy ? <ActivityIndicator color={kind === 'primary' ? theme.onAccent : theme.text} /> : <Text style={[styles.buttonText, kind === 'primary' ? styles.buttonTextOn : kind === 'danger' ? styles.buttonTextDanger : null]}>{label}</Text>}
    </Pressable>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    field: { gap: 6, marginTop: 14 },
    labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
    label: { fontSize: 14, fontWeight: '600', color: p.text },
    counter: { fontSize: 12, color: p.muted },
    helper: { fontSize: 13, color: p.muted },
    note: { fontSize: 13, color: p.notice },
    error: { fontSize: 13, color: p.danger },
    // An explicit background also removes the underline Android draws under a text box.
    input: { backgroundColor: p.background, minHeight: touch.min, borderWidth: 1, borderColor: p.inputBorder, borderRadius: radius.field, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: p.text },
    invalid: { borderColor: p.danger },
    section: { fontSize: 13, fontWeight: '700', letterSpacing: 0.4, color: p.muted, textTransform: 'uppercase', marginTop: 28 },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: touch.min, paddingVertical: 8, marginTop: 6 },
    switchText: { flex: 1, gap: 2 },
    optionLabel: { fontSize: 16, color: p.text },
    group: { gap: 8 },
    radio: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: touch.min, padding: 12, borderWidth: 1, borderColor: p.border, borderRadius: radius.field },
    radioSelected: { borderColor: p.accent, backgroundColor: p.surface },
    dot: { width: 22, height: 22, borderRadius: radius.round, borderWidth: 2, borderColor: p.inputBorder, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    dotSelected: { borderColor: p.accent },
    dotInner: { width: 10, height: 10, borderRadius: radius.round, backgroundColor: p.accent },
    picker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: touch.min, borderWidth: 1, borderColor: p.inputBorder, borderRadius: radius.field, paddingHorizontal: 12 },
    pickerValue: { flex: 1, fontSize: 16, color: p.text },
    chevron: { fontSize: 14, color: p.muted },
    scrim: { flex: 1, backgroundColor: p.text, opacity: 0.4 },
    sheet: { backgroundColor: p.background, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, padding: 16, paddingBottom: 28, maxHeight: '75%', gap: 8 },
    sheetTitle: { fontSize: 17, fontWeight: '600', color: p.text, marginBottom: 4 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: touch.min, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    button: { minHeight: touch.min, borderRadius: radius.field, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 8 },
    buttonPrimary: { backgroundColor: p.accent },
    buttonSecondary: { borderWidth: 1, borderColor: p.inputBorder },
    buttonDanger: { borderWidth: 1, borderColor: p.danger },
    buttonText: { fontSize: 16, fontWeight: '600', color: p.text },
    buttonTextOn: { color: p.onAccent },
    buttonTextDanger: { color: p.danger },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.5 },
  });
