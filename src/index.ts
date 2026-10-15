import joplin from 'api';
import { MenuItemLocation, SettingItemType, ToolbarButtonLocation } from 'api/types';

// Select some text in a note, run "Kavel: image from selection", and the
// generated image is inserted below it as a markdown image.
// Free tier needs no key; a key from https://www.kavel.ai/settings/apikeys
// runs on the account's credits and removes the watermark.

const BASE_URL = 'https://www.kavel.ai';

function anonId(): string {
	const b = new Uint8Array(8);
	crypto.getRandomValues(b);
	return 'joplin-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(prompt: string, apiKey: string, aspectRatio: string): Promise<string> {
	const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : { 'x-anon-id': anonId() };
	const res = await fetch(`${BASE_URL}/api/ai/generate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...auth },
		body: JSON.stringify({
			provider: 'kie',
			mediaType: 'image',
			model: 'kavel-image-v1',
			scene: 'text-to-image',
			prompt,
			options: { aspect_ratio: aspectRatio || '1:1' },
		}),
	});
	const env = await res.json();
	if (env.code !== 0) throw new Error(env.message || 'request refused');
	const d = env.data || {};
	if (d.wall === true) throw new Error(`Free allowance spent for now. Add an API key from ${BASE_URL}/settings/apikeys in Kavel's settings to keep going.`);
	if (!d.id) throw new Error('the service returned no task id');

	// Polling is what moves a queued run forward, so keep asking until it lands.
	const deadline = Date.now() + 360_000;
	while (Date.now() < deadline) {
		await sleep(5000);
		try {
			const r = apiKey
				? await fetch(`${BASE_URL}/api/ai/query`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...auth },
					body: JSON.stringify({ taskId: d.id }),
				})
				: await fetch(`${BASE_URL}/api/ai/anon-query?taskId=${encodeURIComponent(d.id)}&provider=kie&mediaType=image`, { headers: auth });
			const q = await r.json();
			if (q.code !== 0) continue;
			const qd = q.data || {};
			if (qd.cleanImages?.length) return qd.cleanImages[0];
			if (qd.images?.length) return qd.images[0];
			if (qd.status === 'failed' || qd.status === 'error') throw new Error('prompt refused');
		} catch (e) {
			if (String(e).includes('prompt refused')) throw e;
		}
	}
	throw new Error('timed out');
}

joplin.plugins.register({
	onStart: async function() {
		await joplin.settings.registerSection('kavel', {
			label: 'Kavel AI Image',
			iconName: 'fas fa-image',
			description: 'Leave the API key empty to use the free tier.',
		});
		await joplin.settings.registerSettings({
			'kavel.apiKey': {
				value: '',
				type: SettingItemType.String,
				section: 'kavel',
				public: true,
				secure: true,
				label: 'Kavel API key (optional)',
				description: 'From https://www.kavel.ai/settings/apikeys',
			},
			'kavel.aspectRatio': {
				value: '1:1',
				type: SettingItemType.String,
				section: 'kavel',
				public: true,
				label: 'Aspect ratio',
				description: '1:1, 16:9, 9:16, 4:3 or 3:4',
			},
		});

		await joplin.commands.register({
			name: 'kavelImageFromSelection',
			label: 'Kavel: image from selection',
			iconName: 'fas fa-image',
			execute: async () => {
				const prompt = String((await joplin.commands.execute('selectedText')) || '').trim();
				if (!prompt) {
					await joplin.views.dialogs.showMessageBox('Select the text you want turned into an image first.');
					return;
				}
				const apiKey = String(await joplin.settings.value('kavel.apiKey') || '');
				const aspect = String(await joplin.settings.value('kavel.aspectRatio') || '1:1');
				try {
					const url = await generate(prompt, apiKey, aspect);
					const alt = prompt.replace(/[\[\]\n]/g, ' ').slice(0, 80);
					await joplin.commands.execute('replaceSelection', `${prompt}\n\n![${alt}](${url})\n`);
				} catch (e) {
					await joplin.views.dialogs.showMessageBox(`Kavel: ${(e as Error).message || e}`);
				}
			},
		});

		await joplin.views.menuItems.create('kavelMenu', 'kavelImageFromSelection', MenuItemLocation.EditorContextMenu);
		await joplin.views.toolbarButtons.create('kavelButton', 'kavelImageFromSelection', ToolbarButtonLocation.EditorToolbar);
	},
});
