<script setup>
// Универсальное выпадающее меню: слот trigger + слот содержимого, закрытие по клику вне и Esc.
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({ align: { type: String, default: 'right' }, width: { type: String, default: '' } });
const open = ref(false);
const root = ref(null);
function toggle() { open.value = !open.value; }
function close() { open.value = false; }
function onDoc(e) { if (root.value && !root.value.contains(e.target)) close(); }
function onKey(e) { if (e.key === 'Escape') close(); }
onMounted(() => { document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); });
defineExpose({ close, open });
</script>

<template>
  <div class="dropdown" ref="root">
    <div class="dd-trigger" @click="toggle"><slot name="trigger" :open="open" /></div>
    <div v-if="open" class="menu dd-menu" :class="align" :style="width ? { minWidth: width } : {}" @click="close"><slot /></div>
  </div>
</template>

<style>
.dropdown { position: relative; display: inline-block; }
.dd-menu { top: calc(100% + 6px); }
.dd-menu.right { right: 0; }
.dd-menu.left { left: 0; }
</style>
