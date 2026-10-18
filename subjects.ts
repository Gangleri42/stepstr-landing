// The landing pages: one per model, all from one build. A subject's settled data, storyboard and glue live in
// subjects/<id>/, and its page is <page>index.html, which names the subject on <html data-subject>.
// `page` is also where the page, its model and its stills sit in the build ('' is the root). Nothing on a page depends
// on where it sits, so making another page the root is moving the index.html files and swapping their `page` here.
// The build config, the pipeline, the stills script and the tests all read this list; it imports nothing, so Node
// scripts run under tsx can import it too.
export const SUBJECTS: { id: string; page: string }[] = [
	{ id: 'so101', page: '' },
	{ id: 'ii', page: 'ii/' }
];

/** Where the pages are published: og:url and og:image are made absolute against it. */
export const LANDING_ORIGIN = 'https://start.stepstr.space';

/** What `npm run model` and `npm run stills` leave for a subject, relative to the repository. */
export function cacheOf(id: string) {
	const dir = `.cache/landing/${id}`;
	return { dir, summary: `${dir}/summary.json`, model: `${dir}/model`, stills: `${dir}/stills`, review: `${dir}/review` };
}
