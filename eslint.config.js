import js from "@eslint/js";
import globals from "globals";
import pluginVue from "eslint-plugin-vue";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "logs/**",
      "indexeddb/**",
      "public/**",
    ],
  },
  js.configs.recommended,
  ...pluginVue.configs["flat/essential"],
  {
    files: ["**/*.{js,mjs,cjs,vue}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 路由视图按路由名命名（index/setting/settings），改名会牵动路由表，故关闭该规则
      "vue/multi-word-component-names": "off",
      // 与 .prettierrc 保持一致，避免格式化与 lint 互相拉扯
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],
      "object-curly-spacing": ["error", "always"],
      // 日志输出是本项目的调试与备份记录手段，不做限制
      "no-console": "off",
    },
  },
  {
    // 备份流程依赖 \0 清洗 WSL 命令输出中的空字符
    files: ["electron/**/*.cjs"],
    rules: {
      "no-control-regex": "off",
    },
  },
];
