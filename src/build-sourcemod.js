#!/usr/bin/env node
const minifyStream = require("minify-stream");
const inp = process.stdin
    .pipe(minifyStream({sourceMap: false}));

let out = "";
inp.on("data", d => out += d);
inp.on("end", () => {
    process.stdout.write("export const js = " +
        JSON.stringify(
            "data:application/javascript," +
            encodeURIComponent(out)
        ) +
        ";\n");
});
