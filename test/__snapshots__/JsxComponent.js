import { jsx } from "vue/jsx-runtime";
//#region src/runtime/components/JsxComponent.tsx
function MyJSXComponent() {
	return /* @__PURE__ */ jsx("div", { children: "My JSX Component" });
}
//#endregion
export { MyJSXComponent as default };
