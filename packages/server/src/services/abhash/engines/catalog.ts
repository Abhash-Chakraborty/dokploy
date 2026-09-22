import { createHash } from "node:crypto";
import { type EngineDefinition, num, text } from "./types";

const hexOf = (secret: string) =>
	createHash("sha256").update(secret).digest("hex");

/** KRaft needs a base64 UUID, 22 characters; derived so it is stable per stack. */
const kafkaClusterId = (secret: string) =>
	createHash("sha256")
		.update(`kafka:${secret}`)
		.digest()
		.subarray(0, 16)
		.toString("base64url");

const resources = (
	config: Parameters<EngineDefinition["render"]>[0]["config"],
) => {
	const memory = num(config, "memoryMb", 0);
	return memory
		? `    deploy:
      resources:
        limits:
          memory: ${memory}M\n`
		: "";
};

/**
 * Each engine renders a complete compose stack. Nothing is published to the
 * host by default: services talk over the Dokploy network, and a port is
 * only opened when you ask for it (and then the firewall limits it to the
 * mesh).
 */
export const ENGINES: EngineDefinition[] = [
	{
		id: "valkey",
		label: "Valkey",
		category: "key-value",
		description:
			"Redis-compatible, community-governed. A drop-in for anything speaking the Redis protocol.",
		useFor:
			"Caches, sessions, rate-limit counters and job queues (BullMQ, Sidekiq). The open-source Redis successor; anything that speaks Redis works.",
		versions: ["8.1", "8.0", "7.2"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 512,
			},
			{
				name: "persistence",
				label: "Persistence",
				type: "select",
				options: ["aof", "rdb", "none"],
				default: "aof",
			},
			{
				name: "maxmemoryPolicy",
				label: "When memory is full",
				type: "select",
				options: ["noeviction", "allkeys-lru", "volatile-lru"],
				default: "noeviction",
			},
		],
		backup: { kind: "command", note: "redis-cli --rdb" },
		render: ({ name, version, config, password }) => {
			const persistence = text(config, "persistence", "aof");
			const flags = [
				"--requirepass ${VALKEY_PASSWORD}",
				`--maxmemory-policy ${text(config, "maxmemoryPolicy", "noeviction")}`,
				persistence === "aof" ? "--appendonly yes" : "",
				persistence === "none" ? '--save ""' : "",
			]
				.filter(Boolean)
				.join(" ");
			return {
				compose: `services:
  valkey:
    image: valkey/valkey:${version}-alpine
    restart: unless-stopped
    command: valkey-server ${flags}
    volumes:
      - data:/data
${resources(config)}    healthcheck:
      test: ["CMD", "valkey-cli", "-a", "$\{VALKEY_PASSWORD}", "ping"]
      interval: 10s
      retries: 5

volumes:
  data:
`,
				env: { VALKEY_PASSWORD: password },
				connection: [
					{ label: "Host", value: `${name}-valkey` },
					{ label: "Port", value: "6379" },
					{
						label: "URL",
						value: `redis://:$\{VALKEY_PASSWORD}@${name}-valkey:6379`,
					},
				],
				ports: [6379],
			};
		},
	},
	{
		id: "keydb",
		label: "KeyDB",
		category: "key-value",
		description: "Multithreaded Redis fork, for high throughput on one node.",
		useFor:
			"The same jobs as Redis when one busy node needs more throughput. Prefer Valkey unless you know you need KeyDB.",
		versions: ["6.3.4"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 512,
			},
			{ name: "threads", label: "Threads", type: "number", default: 2 },
		],
		// KeyDB tags each version per architecture only; its multi-arch
		// "latest" is the same 6.3.4 images, and the project stopped at 6.3.4.
		render: ({ name, config, password }) => ({
			compose: `services:
  keydb:
    image: eqalpha/keydb:latest
    restart: unless-stopped
    command: keydb-server --requirepass $\{KEYDB_PASSWORD} --server-threads ${num(config, "threads", 2)} --appendonly yes
    volumes:
      - data:/data
${resources(config)}
volumes:
  data:
`,
			env: { KEYDB_PASSWORD: password },
			connection: [
				{
					label: "URL",
					value: `redis://:$\{KEYDB_PASSWORD}@${name}-keydb:6379`,
				},
			],
			ports: [6379],
		}),
	},
	{
		id: "dragonfly",
		label: "Dragonfly",
		category: "key-value",
		description:
			"Redis-compatible store built for multi-core machines and large datasets.",
		useFor:
			"A drop-in Redis for large caches on one machine: much more memory-efficient at tens of GB.",
		versions: ["v1.35.0", "v1.34.1"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 1024,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  dragonfly:
    image: docker.dragonflydb.io/dragonflydb/dragonfly:${version}
    restart: unless-stopped
    ulimits:
      memlock: -1
    command: ["--requirepass=$\{DRAGONFLY_PASSWORD}", "--maxmemory=${num(config, "memoryMb", 1024)}mb"]
    volumes:
      - data:/data
${resources(config)}
volumes:
  data:
`,
			env: { DRAGONFLY_PASSWORD: password },
			connection: [
				{
					label: "URL",
					value: `redis://:$\{DRAGONFLY_PASSWORD}@${name}-dragonfly:6379`,
				},
			],
			ports: [6379],
		}),
	},
	{
		id: "clickhouse",
		label: "ClickHouse",
		category: "analytics",
		description: "Column store for analytics over large event tables.",
		useFor:
			"Product analytics, logs and event tables with millions of rows, where you aggregate rather than update. Plausible, PostHog and Langfuse run on it.",
		versions: ["25.8", "24.8"],
		fields: [
			{
				name: "database",
				label: "Database",
				type: "string",
				default: "analytics",
			},
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 2048,
			},
		],
		backup: { kind: "command", note: "clickhouse-client BACKUP" },
		render: ({ name, version, config, password }) => ({
			compose: `services:
  clickhouse:
    image: clickhouse/clickhouse-server:${version}-alpine
    restart: unless-stopped
    environment:
      CLICKHOUSE_DB: ${text(config, "database", "analytics")}
      CLICKHOUSE_USER: dokploy
      CLICKHOUSE_PASSWORD: $\{CLICKHOUSE_PASSWORD}
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    volumes:
      - data:/var/lib/clickhouse
${resources(config)}    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "localhost:8123/ping"]
      interval: 10s
      retries: 10

volumes:
  data:
`,
			env: { CLICKHOUSE_PASSWORD: password },
			connection: [
				{ label: "HTTP", value: `http://${name}-clickhouse:8123` },
				{ label: "Native", value: `${name}-clickhouse:9000` },
				{ label: "User", value: "dokploy" },
			],
			ports: [8123, 9000],
		}),
	},
	{
		id: "opensearch",
		label: "OpenSearch",
		category: "search",
		description:
			"Search and log analytics, Apache-2.0 licensed, Elasticsearch-compatible API.",
		useFor:
			"Full-text search and log analytics at scale, with an Elasticsearch-compatible API. Heavy: give it at least 2 GB.",
		versions: ["2.19.1", "2.17.1"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 2048,
			},
			{ name: "heapMb", label: "JVM heap (MB)", type: "number", default: 1024 },
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  opensearch:
    image: opensearchproject/opensearch:${version}
    restart: unless-stopped
    environment:
      discovery.type: single-node
      bootstrap.memory_lock: "true"
      OPENSEARCH_JAVA_OPTS: "-Xms${num(config, "heapMb", 1024)}m -Xmx${num(config, "heapMb", 1024)}m"
      OPENSEARCH_INITIAL_ADMIN_PASSWORD: $\{OPENSEARCH_PASSWORD}
    ulimits:
      memlock: -1
      nofile:
        soft: 65536
        hard: 65536
    volumes:
      - data:/usr/share/opensearch/data
${resources(config)}
volumes:
  data:
`,
			env: { OPENSEARCH_PASSWORD: password },
			connection: [
				{ label: "URL", value: `https://${name}-opensearch:9200` },
				{ label: "User", value: "admin" },
			],
			ports: [9200],
		}),
	},
	{
		id: "meilisearch",
		label: "Meilisearch",
		category: "search",
		description: "Fast typo-tolerant search with a simple API.",
		useFor:
			"Search boxes for a website or app: products, docs, articles. Minimal setup, results as you type.",
		versions: ["v1.22", "v1.21"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 512,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  meilisearch:
    image: getmeili/meilisearch:${version}
    restart: unless-stopped
    environment:
      MEILI_MASTER_KEY: $\{MEILI_MASTER_KEY}
      MEILI_ENV: production
    volumes:
      - data:/meili_data
${resources(config)}    healthcheck:
      # busybox wget resolves localhost to ::1, and Meilisearch listens on IPv4.
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:7700/health"]
      interval: 10s
      retries: 10

volumes:
  data:
`,
			env: { MEILI_MASTER_KEY: password },
			connection: [{ label: "URL", value: `http://${name}-meilisearch:7700` }],
			ports: [7700],
		}),
	},
	{
		id: "typesense",
		label: "Typesense",
		category: "search",
		description: "Search engine tuned for instant, typo-tolerant results.",
		useFor:
			"Instant search like Meilisearch, with strong faceting and filtering for catalogues.",
		versions: ["28.0", "27.1"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 512,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  typesense:
    image: typesense/typesense:${version}
    restart: unless-stopped
    command: ["--data-dir", "/data", "--api-key", "$\{TYPESENSE_API_KEY}", "--enable-cors"]
    volumes:
      - data:/data
${resources(config)}
volumes:
  data:
`,
			env: { TYPESENSE_API_KEY: password },
			connection: [{ label: "URL", value: `http://${name}-typesense:8108` }],
			ports: [8108],
		}),
	},
	{
		id: "qdrant",
		label: "Qdrant",
		category: "search",
		description: "Vector database for embeddings and similarity search.",
		useFor:
			"AI features: stores embeddings for semantic search, RAG and recommendations.",
		versions: ["v1.15.1", "v1.14.1"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 1024,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  qdrant:
    image: qdrant/qdrant:${version}
    restart: unless-stopped
    environment:
      QDRANT__SERVICE__API_KEY: $\{QDRANT_API_KEY}
    volumes:
      - data:/qdrant/storage
${resources(config)}
volumes:
  data:
`,
			env: { QDRANT_API_KEY: password },
			connection: [
				{ label: "REST", value: `http://${name}-qdrant:6333` },
				{ label: "gRPC", value: `${name}-qdrant:6334` },
			],
			ports: [6333, 6334],
		}),
	},
	{
		id: "rabbitmq",
		label: "RabbitMQ",
		category: "queue",
		description: "Message broker with the management UI included.",
		useFor:
			"Background jobs and messages between services with delivery guarantees (Celery, MassTransit, Laravel queues).",
		versions: ["4.1", "4.0", "3.13"],
		fields: [
			{ name: "user", label: "User", type: "string", default: "dokploy" },
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 1024,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  rabbitmq:
    image: rabbitmq:${version}-management-alpine
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: ${text(config, "user", "dokploy")}
      RABBITMQ_DEFAULT_PASS: $\{RABBITMQ_PASSWORD}
    volumes:
      - data:/var/lib/rabbitmq
${resources(config)}    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 15s
      retries: 10

volumes:
  data:
`,
			env: { RABBITMQ_PASSWORD: password },
			connection: [
				{
					label: "AMQP",
					value: `amqp://${text(config, "user", "dokploy")}:$\{RABBITMQ_PASSWORD}@${name}-rabbitmq:5672`,
				},
				{ label: "Management UI", value: `http://${name}-rabbitmq:15672` },
			],
			ports: [5672, 15672],
		}),
	},
	{
		id: "nats",
		label: "NATS with JetStream",
		category: "queue",
		description: "Lightweight messaging with persistence through JetStream.",
		useFor:
			"Lightweight pub/sub and request-reply between microservices; JetStream adds durable streams.",
		versions: ["2.12", "2.11"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 512,
			},
			{
				name: "storeMb",
				label: "JetStream storage (MB)",
				type: "number",
				default: 2048,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  nats:
    image: nats:${version}-alpine
    restart: unless-stopped
    # The JetStream store limit only exists in a config file; as a flag it
    # made nats-server print its usage and exit.
    command: ["-c", "/etc/nats/dokploy.conf"]
    configs:
      - source: nats-conf
        target: /etc/nats/dokploy.conf
    volumes:
      - data:/data
${resources(config)}
configs:
  nats-conf:
    content: |
      jetstream {
        store_dir: /data
        max_file_store: ${num(config, "storeMb", 2048)}MB
      }
      authorization {
        token: "$\{NATS_TOKEN}"
      }

volumes:
  data:
`,
			env: { NATS_TOKEN: password },
			connection: [
				{ label: "URL", value: `nats://$\{NATS_TOKEN}@${name}-nats:4222` },
			],
			ports: [4222],
		}),
	},
	{
		id: "kafka",
		label: "Kafka (KRaft)",
		category: "queue",
		description:
			"Single-node Kafka without ZooKeeper. Good for development and modest production loads.",
		useFor:
			"High-volume event streams you replay later: change data capture, event sourcing, analytics pipelines.",
		versions: ["4.0", "3.9"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 2048,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  kafka:
    image: apache/kafka:${version}.0
    restart: unless-stopped
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://${name}-kafka:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@${name}-kafka:9093
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      CLUSTER_ID: ${kafkaClusterId(password)}
    volumes:
      - data:/var/lib/kafka/data
${resources(config)}
volumes:
  data:
`,
			env: {},
			connection: [{ label: "Bootstrap", value: `${name}-kafka:9092` }],
			ports: [9092],
		}),
	},
	{
		id: "garage",
		label: "Garage (S3 storage)",
		category: "storage",
		description:
			"S3-compatible object storage, small and self-hosted. A good target for backups.",
		useFor:
			"S3-compatible object storage on your own disk: uploads, backups and static files without AWS.",
		versions: ["v2.1.0", "v1.0.1"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 512,
			},
		],
		render: ({ name, version, config, password }) => ({
			compose: `services:
  garage:
    image: dxflrs/garage:${version}
    restart: unless-stopped
    environment:
      GARAGE_ALLOW_WORLD_READABLE_SECRETS: "true"
    # A bind-mounted ./garage.toml was never written, so Docker created a
    # directory in its place and garage could not read its config.
    configs:
      - source: garage-conf
        target: /etc/garage.toml
    volumes:
      - meta:/var/lib/garage/meta
      - data:/var/lib/garage/data
${resources(config)}
configs:
  garage-conf:
    content: |
      metadata_dir = "/var/lib/garage/meta"
      data_dir = "/var/lib/garage/data"
      db_engine = "lmdb"
      replication_factor = 1
      rpc_bind_addr = "[::]:3901"
      rpc_public_addr = "127.0.0.1:3901"
      rpc_secret = "$\{GARAGE_RPC_SECRET}"

      [s3_api]
      s3_region = "garage"
      api_bind_addr = "[::]:3900"
      root_domain = ".s3.garage"

      [admin]
      api_bind_addr = "[::]:3903"
      admin_token = "$\{GARAGE_ADMIN_TOKEN}"

volumes:
  meta:
  data:
`,
			// Garage wants its RPC secret as 32 bytes of hex.
			env: { GARAGE_RPC_SECRET: hexOf(password), GARAGE_ADMIN_TOKEN: password },
			connection: [
				{ label: "S3 endpoint", value: `http://${name}-garage:3900` },
				{
					label: "Setup",
					value:
						"Run `garage layout assign` once, then create a key and bucket",
				},
			],
			ports: [3900, 3903],
		}),
	},
	{
		id: "mongo-replicaset",
		label: "MongoDB replica set",
		category: "document",
		description:
			"Three-member replica set with keyfile authentication, for transactions and failover.",
		useFor:
			"MongoDB when you need transactions or change streams, which require a replica set. For a simple MongoDB, use the built-in one in a project.",
		versions: ["8.0", "7.0"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit per member (MB)",
				type: "number",
				default: 1024,
			},
		],
		render: ({ name, version, config, password }) => {
			const member = (index: number) => `  mongo${index}:
    image: mongo:${version}
    restart: unless-stopped
    command: ["--replSet", "rs0", "--keyFile", "/etc/mongo-keyfile", "--bind_ip_all"]
    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: $\{MONGO_PASSWORD}
    entrypoint:
      - bash
      - -c
      - |
        echo "$\{MONGO_KEYFILE}" > /etc/mongo-keyfile
        chmod 400 /etc/mongo-keyfile
        chown mongodb:mongodb /etc/mongo-keyfile
        exec docker-entrypoint.sh "$$@"
      - --
    volumes:
      - data${index}:/data/db
${resources(config)}`;
			const hosts = [1, 2, 3]
				.map(
					(index) =>
						`{ _id: ${index - 1}, host: "${name}-mongo${index}:27017" }`,
				)
				.join(", ");
			// Members are named by their Dokploy-network address, so the replica
			// set hands clients hosts they can reach from other stacks.
			const init = `  mongo-init:
    image: mongo:${version}
    restart: on-failure
    depends_on: [mongo1, mongo2, mongo3]
    labels:
      com.abhash.oneshot: "true"
    environment:
      MONGO_PASSWORD: $\{MONGO_PASSWORD}
    entrypoint:
      - bash
      - -c
      - |
        uri="mongodb://root:$$MONGO_PASSWORD@mongo1:27017/admin?directConnection=true"
        until mongosh --quiet "$$uri" --eval "db.adminCommand({ ping: 1 })" >/dev/null 2>&1; do sleep 2; done
        mongosh --quiet "$$uri" --eval '
          try { rs.status(); print("replica set already initiated"); }
          catch (e) { rs.initiate({ _id: "rs0", members: [${hosts}] }); print("replica set initiated"); }'
`;
			return {
				compose: `services:
${[1, 2, 3].map(member).join("\n")}
${init}
volumes:
  data1:
  data2:
  data3:
`,
				// A keyfile may only hold base64 characters; the password is
				// base64url, whose - and _ mongod rejects.
				env: { MONGO_PASSWORD: password, MONGO_KEYFILE: hexOf(password) },
				connection: [
					{
						label: "URI",
						value: `mongodb://root:$\{MONGO_PASSWORD}@${name}-mongo1:27017,${name}-mongo2:27017,${name}-mongo3:27017/?replicaSet=rs0`,
					},
				],
				ports: [27017],
			};
		},
	},
];

export const engineById = (id: string) =>
	ENGINES.find((engine) => engine.id === id);

/** Image presets for the Postgres service upstream already has. */
export const POSTGRES_FLAVOURS = [
	{
		id: "postgres",
		label: "Postgres",
		images: ["postgres:18-alpine", "postgres:17-alpine", "postgres:16-alpine"],
		extensions: ["pg_stat_statements", "pgcrypto", "uuid-ossp", "hstore"],
	},
	{
		id: "pgvector",
		label: "Postgres with pgvector",
		images: ["pgvector/pgvector:pg18", "pgvector/pgvector:pg17"],
		extensions: ["vector", "pg_stat_statements", "pgcrypto"],
	},
	{
		id: "postgis",
		label: "Postgres with PostGIS",
		images: ["postgis/postgis:17-3.5", "postgis/postgis:16-3.4"],
		extensions: ["postgis", "postgis_topology", "pg_stat_statements"],
	},
	{
		id: "timescale",
		label: "Postgres with TimescaleDB",
		images: [
			"timescale/timescaledb:2.17.2-pg17",
			"timescale/timescaledb:2.17.2-pg16",
		],
		extensions: ["timescaledb", "pg_stat_statements"],
	},
];
