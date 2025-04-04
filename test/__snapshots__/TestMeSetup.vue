<script setup>
defineProps({
  count: {
    type: Number,
    required: true
  }
});
</script>

<template>
  <div>
    {{ count }}
  </div>
</template>
