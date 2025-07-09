import * as fs from "fs/promises";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const terserPlugin = [terser({
    format: {
        preamble: await fs.readFile("src/license.js", "utf8")
    }
})];

export default {
    input: "src/main.ts",
    output: [
        {
            file: "dist/rtennui.mjs",
            format: "es",
            plugins: terserPlugin
        },
        {
            file: "dist/rtennui.min.mjs",
            format: "es",
            plugins: terserPlugin
        },
        {
            file: "dist/rtennui.js",
            format: "umd",
            name: "RTEnnui"
        },
        {
            file: "dist/rtennui.min.js",
            format: "umd",
            name: "RTEnnui",
            plugins: terserPlugin
        }
    ],
    plugins: [
        typescript(),
        nodeResolve()
    ]
};
