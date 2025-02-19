import { ref, getCurrentInstance, App, ComponentPublicInstance, defineComponent } from "vue";
import { i18n, TFunction, TOptions } from "i18next";

declare module 'vue' {
    interface ComponentCustomProperties {
        $t: TFunction;
        $i18next: i18n;
    }
}
type SimpleTFunction = (key: string, options?: TOptions | string) => string;
type ComponentI18nInstance = ComponentPublicInstance & {
    __bundles?: Array<[string, string]>;  // the bundles loaded by the component
    __translate?: SimpleTFunction; // local to each component with an <i18n> block or i18nOptions
};

type Messages = { [index: string]: string | Messages };
declare module 'vue' {
    interface ComponentCustomOptions {
        __i18n?: string[]; // due to package @intlify/vue-i18n-loader, each component with at least one <i18n> block has __i18n set
        i18nOptions?: {
            lng?: string;
            keyPrefix?: string;
            namespaces?: string | string[];
            messages?: Messages;
        }
    }
}

interface VueI18NextOptions {
    i18next: i18n;
    rerenderOn?: ('languageChanged' | 'loaded' | 'added' | 'removed')[];
}

export default function install(app: App, {
    i18next,
    rerenderOn = ['languageChanged', 'loaded', 'added', 'removed'],
}: VueI18NextOptions): void {
    const genericT = i18next.t.bind(i18next);
    // the ref (internally) tracks which Vue instances use translations
    // Vue will automatically trigger re-renders when the value of 'lastI18nChange' changes
    const lastI18nChange = ref(new Date());
    const invalidate: () => void = () => lastI18nChange.value = new Date();
    const usingI18n: () => void = () => lastI18nChange.value;
    rerenderOn.forEach(event => {
        switch (event) {
            case 'added':
            case 'removed':
                i18next.store?.on(event, invalidate);
                break;
            default:
                i18next.on(event, invalidate)
                break;
        }
    })

    app.component('i18next', TranslationComponent);
    app.mixin({
        beforeCreate(this: ComponentI18nInstance) {
            const options = this.$options;
            if (!options.__i18n && !options.i18nOptions) {
                this.__translate = undefined;  // required to enable proxied access to `__translate` in the $t function
                return;
            }

            // each component gets its own 8-digit random namespace prefixed with its name if available
            const name = this.$options.name;
            const rand = ((Math.random() * 10 ** 8) | 0).toString();
            const localNs = [name, rand].filter(x => !!x).join("-");

            // used to store added resource bundle identifiers for later removal upen component destruction
            this.__bundles = [];
            const loadBundle = (bundle: Messages) => {
                Object.entries(bundle).forEach(([lng, resources]) => {
                    i18next.addResourceBundle(lng, localNs, resources, true, false);
                    this.__bundles!.push([lng, localNs]);
                });
            }

            // iterate all <i18n> blocks' contents as provided by @intlify/vue-i18n-loader and make them available to i18next
            options.__i18n?.forEach(bundle => {
                loadBundle(JSON.parse(bundle));
            });

            let { lng, ns, keyPrefix } = handleI18nOptions(options, loadBundle);
            if (this.__bundles?.length) { // has local translations
                ns = [localNs].concat(ns ?? []); // add component-local namespace, thus finding and preferring local translations
            }

            const t = getTranslationFunction(lng, ns);
            this.__translate = (key, options) => {
                if (!keyPrefix || includesNs(key)) {
                    return t(key, options);
                } else { // adding keyPrefix only if key is not namespaced
                    return t(keyPrefix + '.' + key, options);
                }
            };
        },
        unmounted(this: ComponentI18nInstance) {
            this.__bundles?.forEach(([lng, ns]) => i18next.removeResourceBundle(lng, ns)); // avoid memory leaks
        }
    });

    app.config.globalProperties.$t = function (this: ComponentI18nInstance | undefined, key, options) {
        usingI18n(); // called during render, so we will get re-rendered when translations change
        if (i18next.isInitialized) {
            return (this?.__translate ?? genericT)(key, options);
        } else {
            return key;
        }
    } as SimpleTFunction;
    // this proxy makes things like $i18next.language (basically) reactive
    app.config.globalProperties.$i18next = new Proxy(i18next, {
        get(target, prop) {
            usingI18n();
            return Reflect.get(target, prop);
        }
    });

    /** Translation function respecting lng and ns. The namespace can be overriden in $t calls using a key prefix or the 'ns' option. */
    function getTranslationFunction(lng?: string, ns?: string[]): TFunction {
        if (lng) {
            return i18next.getFixedT(lng, ns);
        } else if (ns) {
            return i18next.getFixedT(null, ns);
        } else {
            return genericT;
        }
    }

    function includesNs(key: string): boolean {
        const nsSeparator = i18next.options.nsSeparator;
        return typeof nsSeparator === "string" && key.includes(nsSeparator);
    }

    function handleI18nOptions(options: any, loadBundle: (bundle: Messages) => void) {
        let lng: string | undefined;
        let ns: string[] | undefined;
        let keyPrefix: string | undefined;
        if (options.i18nOptions) {
            let messages: Messages | undefined;
            let namespaces: string | string[] | undefined;
            ({
                lng,
                namespaces = i18next.options.defaultNS,
                keyPrefix,
                messages,
            } = options.i18nOptions);

            // make i18nOptions.messages available to i18next
            if (messages) {
                loadBundle(messages);
            }

            ns = typeof namespaces === 'string' ? [namespaces] : namespaces;
            if (ns) {
                i18next.loadNamespaces(ns); // load configured namespaces
            }
        }
        return { lng, ns, keyPrefix };
    }
}

export function useTranslation() {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error("i18next-vue: No Vue instance in context. Make sure to register the i18next-vue plugin using app.use(...).");
    }
    const globalProps = instance.appContext.config.globalProperties;
    return {
        i18next: globalProps.$i18next as i18n,
        t: globalProps.$t.bind(instance.proxy) as SimpleTFunction
    }
}

// pattern matches '{ someSlot }'
const slotNamePattern = new RegExp('{\\s*([a-z0-9\\-]+)\\s*}', 'gi');
export const TranslationComponent = defineComponent({
    props: {
        "translation": {
            type: String,
            required: true
        }
    },
    setup(props, { slots }) {
        return () => {
            const translation = props.translation;
            const result = [];

            let match;
            let lastIndex = 0;
            while ((match = slotNamePattern.exec(translation)) !== null) {
                result.push(translation.substring(lastIndex, match.index))
                const slot = slots[match[1]];
                if (slot) {
                    result.push(...slot());
                } else {
                    result.push(match[0]);
                }
                lastIndex = slotNamePattern.lastIndex;
            }
            result.push(translation.substring(lastIndex))
            return result;
        };
    }
});
