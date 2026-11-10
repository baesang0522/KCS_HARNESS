const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../../src/static/excel');

class Element {
    constructor(tag, attrs = {}) {
        this.tagName = tag; this.attrs = attrs; this.children = []; this.parentNode = null;
        this.listeners = {}; this.dataset = {}; this.value = ''; this.hidden = 'hidden' in attrs;
        this.disabled = false; this.readOnly = false; this._text = '';
        this.classList = {add: name => { this.attrs.class = ((this.attrs.class || '') + ' ' + name).trim(); }};
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    replaceChildren(...nodes) { this.textContent = ''; nodes.forEach(node => this.appendChild(node)); }
    get selectedOptions() { return this.children.filter(child => child.selected || child.value === this.value); }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = value; this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
    set className(value) { this.attrs.class = value; }
    get className() { return this.attrs.class || ''; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, next) {
        if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
        const index = next ? this.children.indexOf(next) : this.children.length;
        if (index < 0) throw new Error('reference node is not a child');
        this.children.splice(index, 0, child); child.parentNode = this; return child;
    }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async emit(type, fields = {}) {
        const event = {type, target: this, preventDefault() {}, ...fields};
        for (const handler of this.listeners[type] || []) await handler.call(this, event);
    }
    focus() { this.focused = true; }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map(value => value.trim());
        const matches = (node, value) => {
            if (value[0] === '.') return node.className.split(' ').includes(value.slice(1));
            const parsed = value.match(/^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
            return !!parsed && (!parsed[1] || node.tagName === parsed[1]) &&
                (!parsed[2] || parsed[2] in node.attrs && (parsed[3] === undefined || node.attrs[parsed[2]] === parsed[3]));
        };
        const found = [];
        const visit = node => node.children.forEach(child => { if (selectors.some(value => matches(child, value))) found.push(child); visit(child); });
        visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createDOM() {
    const document = new Element('document'), stack = [document];
    const html = fs.readFileSync(path.join(root, 'taskpane.html'), 'utf8');
    for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/gi)) {
        const [, closing, tag, rest] = match;
        if (closing) { while (stack.length > 1 && stack.pop().tagName !== tag) {} continue; }
        const attrs = {};
        for (const attr of rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? '';
        const node = new Element(tag, attrs); stack.at(-1).appendChild(node);
        if (!['meta', 'link', 'input', 'img', 'br', 'hr'].includes(tag) && !rest.endsWith('/')) stack.push(node);
    }
    document.getElementById = id => document.querySelector(`[id="${id}"]`);
    document.createElement = tag => new Element(tag);
    const messages = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/services/error_messages.json'), 'utf8'));
    document.getElementById('server-error-messages').textContent = JSON.stringify(messages);
    const values = new Map();
    const localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
    const window = {errorMessages: messages, setTimeout: () => 1, clearTimeout() {}, markdownRenderer: {render: (node, text) => { node.textContent = text; }}};
    const sandbox = vm.createContext({window, document, localStorage, navigator: {userAgent: 'test'}, AbortController, DOMException, console});
    return {window, document, localStorage, sandbox,
        load: file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, {filename: file})};
}
module.exports = {createDOM};
