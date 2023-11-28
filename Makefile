SRC=\
	src/*.ts

all: rtennui.js rtennui.min.js

rtennui.js: $(SRC) node_modules/.bin/browserify
	./src/build.js > $@

rtennui.min.js: rtennui.js node_modules/.bin/browserify
	./node_modules/.bin/minify --js < $< | cat src/license.js - > $@

node_modules/.bin/browserify:
	npm install

clean:
	rm -f rtennui.js rtennui.min.js
