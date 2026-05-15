<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, reactive } from "vue";

const props = defineProps<{
  modelValue: string;
  options: readonly { value: string; label: string }[];
  variant: "layout" | "pill";
  ariaLabel: string;
  title?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);
const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);

const panelId = `dm-tms-p-${Math.random().toString(36).slice(2, 9)}`;

const menuFixed = reactive({
  left: "0px",
  top: "0px",
  width: "0px",
});

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);

function updateMenuPosition(): void {
  const el = anchorRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const gap = 5;
  menuFixed.left = `${r.left}px`;
  menuFixed.top = `${r.bottom + gap}px`;
  menuFixed.width = `${Math.max(r.width, 72)}px`;
}

let posListenersAttached = false;
function attachPosListeners(): void {
  if (posListenersAttached) return;
  posListenersAttached = true;
  window.addEventListener("resize", updateMenuPosition);
  window.addEventListener("scroll", updateMenuPosition, true);
}

function detachPosListeners(): void {
  if (!posListenersAttached) return;
  posListenersAttached = false;
  window.removeEventListener("resize", updateMenuPosition);
  window.removeEventListener("scroll", updateMenuPosition, true);
}

watch(open, async (isOpen) => {
  if (isOpen) {
    await nextTick();
    updateMenuPosition();
    attachPosListeners();
  } else detachPosListeners();
});

function toggle(): void {
  open.value = !open.value;
}

function pick(value: string): void {
  emit("update:modelValue", value);
  open.value = false;
  triggerRef.value?.focus();
}

function onDocPointerDown(e: PointerEvent): void {
  if (!open.value) return;
  const t = e.target as Node | null;
  if (!t) return;
  if (panelRef.value?.contains(t) || anchorRef.value?.contains(t)) return;
  open.value = false;
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (!open.value || e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  open.value = false;
  triggerRef.value?.focus();
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onGlobalKeydown, true);
});

onBeforeUnmount(() => {
  detachPosListeners();
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onGlobalKeydown, true);
});
</script>

<template>
  <div
    ref="anchorRef"
    class="dm-tms-shell"
    :class="[
      variant === 'layout' ? 'dm-tms-shell--layout' : 'dm-tms-shell--pill',
      { 'dm-tms-shell--open': open },
    ]"
    :title="title"
  >
    <button
      :id="`${panelId}-btn`"
      ref="triggerRef"
      type="button"
      class="dm-tms-trigger"
      :class="variant === 'layout' ? 'dm-tms-trigger--layout' : 'dm-tms-trigger--pill'"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="panelId"
      :aria-label="ariaLabel"
      @click="toggle"
    >
      <span class="dm-tms-trigger-label">{{ currentLabel }}</span>
      <span
        class="dm-tms-chevron"
        :class="{ 'dm-tms-chevron--pill': variant === 'pill', 'dm-tms-chevron--open': open }"
        aria-hidden="true"
        >▾</span
      >
    </button>
  </div>

  <Teleport to="body">
    <Transition name="dm-tms-fade">
      <div
        v-if="open"
        :id="panelId"
        ref="panelRef"
        role="listbox"
        class="dm-tms-panel"
        :class="variant === 'layout' ? 'dm-tms-panel--layout' : 'dm-tms-panel--pill'"
        :aria-labelledby="`${panelId}-btn`"
        :style="{
          ...menuFixed,
          position: 'fixed',
          zIndex: '100055',
          boxSizing: 'border-box',
        }"
      >
        <button
          v-for="opt in options"
          :key="opt.value"
          type="button"
          role="option"
          class="dm-tms-option"
          :class="{ 'dm-tms-option--active': opt.value === modelValue }"
          :aria-selected="opt.value === modelValue"
          @click="pick(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dm-tms-shell {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
  box-sizing: border-box;
}

.dm-tms-shell--layout {
  min-width: clamp(5.2rem, 4.05rem + 2.85cqw, 6.55rem);
  max-width: 100%;
  min-height: var(--dm-toolbar-row-h, 1.42rem);
  height: var(--dm-toolbar-row-h, 1.42rem);
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 42%, transparent);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    background 0.16s ease;
}

.dm-tms-shell--layout.dm-tms-shell--open,
.dm-tms-shell--layout:focus-within {
  background: color-mix(in srgb, var(--surface) 54%, transparent);
  border-color: color-mix(in srgb, var(--primary) 52%, var(--border));
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--primary) 22%, transparent),
    inset 0 1px 1px rgba(0, 0, 0, 0.04);
}

.dm-toolbar-layout-slot .dm-tms-shell--layout {
  flex-shrink: 1;
  min-width: 0;
}

.dm-toolbar-mode-cluster .dm-toolbar-layout-slot .dm-tms-shell--layout {
  flex-shrink: 0;
}

.dm-tms-trigger {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: inherit;
  background: transparent;
  font-family: inherit;
  font-size: var(--dm-toolbar-fs, 0.72rem);
  line-height: var(--dm-toolbar-lh, 1.2);
  outline: none;
  text-align: left;
}

.dm-tms-trigger--layout {
  padding: 0 clamp(1.02rem, 0.74rem + 0.92cqw, 1.22rem) 0 clamp(0.4rem, 0.26rem + 0.62cqw, 0.52rem);
  color: var(--dm-trigger-label, color-mix(in srgb, var(--primary) 44%, var(--text)));
  font-weight: 650;
}

.dm-tms-trigger--layout:hover {
  color: var(--dm-trigger-label-hover, color-mix(in srgb, var(--primary) 58%, var(--text)));
}

.dm-tms-shell--pill.dm-tms-shell--open .dm-tms-trigger--pill,
.dm-tms-shell--pill:focus-within .dm-tms-trigger--pill {
  color: var(--dm-ui-body, var(--text));
}

.dm-tms-trigger-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dm-tms-chevron {
  position: absolute;
  right: clamp(0.34rem, 0.22rem + 0.58cqw, 0.46rem);
  top: 50%;
  translate: 0 -50%;
  font-size: clamp(0.46rem, 0.4rem + 0.42cqw, 0.52rem);
  line-height: 1;
  opacity: 0.58;
  color: color-mix(in srgb, var(--muted) 94%, var(--text));
  pointer-events: none;
  transition:
    rotate 0.16s ease,
    opacity 0.16s ease;
}

.dm-tms-shell--layout.dm-tms-shell--open .dm-tms-chevron,
.dm-tms-shell--layout:focus-within .dm-tms-chevron {
  opacity: 0.82;
  color: color-mix(in srgb, var(--primary) 48%, var(--muted));
}

.dm-tms-chevron--pill {
  right: clamp(0.26rem, 0.14rem + 0.62cqw, 0.38rem);
}

.dm-tms-chevron--open {
  rotate: -180deg;
}

.dm-tms-shell--pill {
  flex: 1 1 auto;
  min-width: clamp(3.92rem, 3.52rem + 2.05cqw, 4.55rem);
  max-width: 8.65rem;
  border-radius: 999px 0 0 999px / 999px;
  overflow: hidden;
  background: transparent;
}

.dm-tms-trigger--pill {
  padding: 0 clamp(0.88rem, 0.72rem + 0.92cqw, 1.05rem) 0 clamp(0.32rem, 0.24rem + 0.55cqw, 0.44rem);
  color: var(--dm-trigger-label, color-mix(in srgb, var(--primary) 44%, var(--text)));
  font-weight: 650;
}

.dm-tms-trigger--pill:hover {
  color: var(--dm-ui-body, var(--text));
}

.dm-tms-shell--pill:focus-within,
.dm-tms-shell--pill.dm-tms-shell--open {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}

.dm-tms-trigger:focus-visible {
  outline: none;
}

/* 展开面板：与外框同色系的「框」（非系统下拉） */
/* Teleport 到 body：本地定义与同面板语义一致的字色，避免丢失 .dm-panel 继承 */
.dm-tms-panel {
  --dm-tms-muted: color-mix(in srgb, var(--muted) 72%, var(--text));
  --dm-tms-strong: color-mix(in srgb, var(--primary) 82%, var(--text));
  margin: 0;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(22px) saturate(1.2);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text) 5%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 12px 42px rgba(0, 0, 0, 0.24);
}

.dm-tms-panel--pill {
  padding: 5px;
  border-radius: 12px;
}

.dm-tms-option {
  cursor: pointer;
  display: block;
  width: 100%;
  margin: 0;
  padding: 0 clamp(0.42rem, 0.26rem + 0.72cqw, 0.52rem);
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dm-tms-muted);
  font-family: inherit;
  font-weight: 600;
  font-size: var(--dm-toolbar-fs, 0.72rem);
  line-height: var(--dm-toolbar-lh, 1.2);
  text-align: left;
  outline: none;
  min-height: calc(var(--dm-toolbar-row-h, 1.42rem) * 1.06);
  box-sizing: border-box;
  transition:
    background 0.13s ease,
    color 0.13s ease,
    transform 0.09s ease;
}

.dm-tms-option + .dm-tms-option {
  margin-top: 2px;
}

.dm-tms-option:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.dm-tms-option:active {
  transform: scale(0.988);
}

.dm-tms-option--active {
  color: var(--dm-tms-strong);
  font-weight: 650;
  background: linear-gradient(
    165deg,
    color-mix(in srgb, var(--surface) 55%, transparent) 0%,
    color-mix(in srgb, var(--primary) 18%, transparent) 108%
  );
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.062),
    0 0 0 1px color-mix(in srgb, var(--primary) 34%, transparent);
}

.dm-tms-option:focus-visible {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--primary) 44%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.062);
}

.dm-tms-option:focus-visible.dm-tms-option--active {
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--primary) 50%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.062),
    0 0 0 1px color-mix(in srgb, var(--primary) 34%, transparent);
}

.dm-tms-fade-enter-active,
.dm-tms-fade-leave-active {
  transition:
    opacity 0.13s ease,
    transform 0.13s ease;
}

.dm-tms-fade-enter-from,
.dm-tms-fade-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}

@container dm-col-toolbar (max-width: 520px) {
  .dm-tms-shell--layout {
    min-width: clamp(4.45rem, 3.88rem + 2.62cqw, 5.5rem);
  }

  .dm-tms-trigger--layout {
    padding-inline-start: clamp(0.32rem, 0.24rem + 0.62cqw, 0.42rem);
    padding-inline-end: clamp(0.88rem, 0.62rem + 0.92cqw, 1.05rem);
  }

  .dm-tms-shell--pill {
    min-width: clamp(3.55rem, 3.32rem + 1.92cqw, 4.2rem);
  }

  .dm-tms-trigger--pill {
    padding-inline-start: clamp(0.28rem, 0.22rem + 0.48cqw, 0.38rem);
    padding-inline-end: clamp(0.82rem, 0.58rem + 0.92cqw, 0.98rem);
  }
}

@container dm-col-toolbar (max-width: 400px) {
  .dm-tms-trigger--layout {
    padding-inline-start: clamp(0.26rem, 0.22rem + 0.42cqw, 0.34rem);
    padding-inline-end: clamp(0.74rem, 0.52rem + 0.92cqw, 0.9rem);
  }

  .dm-tms-trigger--pill {
    padding-inline-start: clamp(0.22rem, 0.18rem + 0.38cqw, 0.3rem);
    padding-inline-end: clamp(0.68rem, 0.48rem + 0.92cqw, 0.84rem);
  }
}
</style>
