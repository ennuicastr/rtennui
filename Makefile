SRC=src/*.ts src/cap-awp-js.ts src/cap-awp-waiter-js.ts src/play-awp-js.ts

all: rtennui.js rtennui.min.js

rtennui.js: $(SRC) node_modules/.bin/browserify
	./src/build.js > $@

rtennui.min.js: $(SRC) node_modules/.bin/browserify
	./src/build.js -m > $@

%-js.ts: %.ts node_modules/.bin/browserify
	./node_modules/.bin/tsc --target es2017 --lib es2017,dom $< --outFile /dev/stdout | ./src/build-sourcemod.js > $@

node_modules/.bin/browserify:
	npm install

clean:
	rm -f rtennui.js rtennui.min.js src/*-js.ts
