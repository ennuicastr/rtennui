all: dist/rtennui.js dist/rtennui.min.js

dist/rtennui.js dist/rtennui.min.js: src/*.ts node_modules/.bin/tsc
	npm run build

node_modules/.bin/tsc:
	npm install

clean:
	rm -rf dist
