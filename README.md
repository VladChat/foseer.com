# Foseer

Foseer is a news and analysis website covering business, technology, politics, society, and culture.

## Project Structure

```
/
├── public/
│   └── robots.txt
├── src/
│   ├── assets/
│   │   ├── images/
│   │   └── styles/
│   │       └── tailwind.css
│   ├── components/
│   │   ├── blog/
│   │   ├── common/
│   │   ├── ui/
│   │   └── widgets/
│   ├── content/
│   │   └── config.ts
│   ├── data/
│   │   ├── post/
│   │   ├── taxonomy.json
│   │   └── topic-metrics.json
│   ├── layouts/
│   │   ├── Layout.astro
│   │   ├── MarkdownLayout.astro
│   │   └── PageLayout.astro
│   ├── pages/
│   │   ├── [...blog]/
│   │   ├── sections/
│   │   ├── index.astro
│   │   └── 404.astro
│   ├── utils/
│   ├── config.yaml
│   ├── navigation.ts
│   └── types.d.ts
├── package.json
├── astro.config.ts
└── ...
```

## Commands

All commands are run from the root of the project:

| Command           | Action                                      |
| :---------------- | :------------------------------------------ |
| `npm install`     | Installs dependencies                       |
| `npm run dev`     | Starts local dev server at `localhost:4321` |
| `npm run build`   | Build your production site to `./dist/`     |
| `npm run preview` | Preview your build locally                  |
| `npm run check`   | Check your project for errors               |
| `npm run fix`     | Run Eslint and format with Prettier         |

## Configuration

Basic configuration file: `./src/config.yaml`

## Content Management

### Posts

Blog posts are stored in `src/data/post/` as `.mdx` files.

Each post has frontmatter with:
- `title`: Post title
- `excerpt`: Short summary
- `publishDate`: Publication date (YYYY-MM-DD)
- `category`: Category slug
- `tags`: Array of topic tags
- `author`: Author name

### Taxonomy

Sections and topics are defined in `src/data/taxonomy.json`.

Topic engagement metrics are tracked in `src/data/topic-metrics.json`.

## Deployment

Build the production site:

```shell
npm run build
```

Deploy the `dist` folder to your hosting service.

## License

Foseer is proprietary software. All rights reserved.
