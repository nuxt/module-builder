<script>
import { defineComponent as _defineComponent } from "vue";
export default /* @__PURE__ */ _defineComponent({
  __name: "TestMeSetup",
  props: {
    count: { type: Number, required: true }
  },
  setup(__props, { expose: __expose }) {
    __expose();
    const __returned__ = {};
    Object.defineProperty(__returned__, "__isScriptSetup", { enumerable: false, value: true });
    return __returned__;
  }
});
</script>

<template>
  <div>
    {{ count }}
  </div>
</template>
