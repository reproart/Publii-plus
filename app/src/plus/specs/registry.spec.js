const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const compiler = require('vue-template-compiler');
const Vue = require('vue');

// registry.js is an ES module bundled by webpack – load createRegistry() without the bundler
const registrySource = fs.readFileSync(path.join(__dirname, '../registry.js'), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace('export function createRegistry', 'function createRegistry')
    .replace(/^export default \{[\s\S]*$/m, 'module.exports = { createRegistry };');
const registryContext = { module: { exports: {} } };
vm.runInNewContext(registrySource, registryContext);
const { createRegistry } = registryContext.module.exports;

function loadComponent (file) {
    const parsed = compiler.parseComponent(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    const compiled = compiler.compile(parsed.template.content);
    const ctx = { module: { exports: {} } };
    vm.runInNewContext(parsed.script.content.replace(/^import .*;\s*$/gm, '').replace('export default', 'module.exports ='), ctx);
    return {
        ...ctx.module.exports,
        render: new Function(compiled.render),
        staticRenderFns: compiled.staticRenderFns.map(code => new Function(code))
    };
}

describe('Publii Plus renderer registry', () => {
    it('groups slot components by name in extension order and skips invalid entries', () => {
        const A = { name: 'a' };
        const B = { name: 'b' };
        const registry = createRegistry([
            { id: 'one', slots: { about: A, 'post-sidebar': A } },
            null,
            { slots: { about: B } },
            { id: 'two', slots: { about: B } }
        ]);

        assert.deepEqual(Array.from(registry.ids), ['one', 'two']);
        assert.deepEqual(Array.from(registry.getSlot('about'), e => [e.extensionId, e.component]), [['one', A], ['two', B]]);
        assert.equal(registry.getSlot('missing').length, 0);
    });

    it('invoke() fails clearly without the preload bridge', async () => {
        await assert.rejects(createRegistry([]).invoke('core', 'info'), /bridge is not available/);
    });

    it('<plus-slot> renders registered components with the context prop', () => {
        const PlusSlot = loadComponent('../PlusSlot.vue');
        const Item = { props: ['context'], render (h) { return h('span', { class: 'item' }, 'ctx:' + this.context); } };
        const LocalVue = Vue.extend({});
        LocalVue.prototype.$plus = createRegistry([{ id: 'x', slots: { demo: Item } }]);

        const slot1 = new LocalVue({ ...PlusSlot, propsData: { name: 'demo', context: 42 } });
        const vnode = slot1._render();
        assert.equal(vnode.data.class, 'plus-slot plus-slot--demo');
        assert.equal(vnode.children.length, 1);
        assert.equal(vnode.children[0].componentOptions.Ctor.options.render, Item.render);
        assert.equal(vnode.children[0].componentOptions.propsData.context, 42);

        const slot2 = new LocalVue({ ...PlusSlot, propsData: { name: 'empty' } });
        assert.equal(slot2._render().isComment, true, 'renders nothing when the slot has no components');
    });
});
