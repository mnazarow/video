<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
const props = defineProps({ title: { type: String, default: '' }, wide: Boolean, narrow: Boolean, noClose: Boolean });
const emit = defineEmits(['close']);
function onKey(e) { if (e.key === 'Escape' && !props.noClose) emit('close'); }
onMounted(() => { document.addEventListener('keydown', onKey); document.body.classList.add('no-scroll'); });
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); });
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @mousedown.self="!noClose && $emit('close')">
      <div class="modal" :class="{ wide, narrow }" role="dialog" aria-modal="true">
        <div class="modal-head" v-if="title || $slots.head">
          <slot name="head"><h3>{{ title }}</h3></slot>
          <button v-if="!noClose" class="ibtn" @click="$emit('close')" aria-label="Закрыть"><Icon name="close" /></button>
        </div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot" v-if="$slots.footer"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>
