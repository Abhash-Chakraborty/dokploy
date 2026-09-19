import { bool, type EngineDefinition, num, text } from "./types";

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
		render: ({ name, version, config, password }) => ({
			compose: `services:
  keydb:
    image: eqalpha/keydb:x86_64_v${version}
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
      test: ["CMD", "wget", "--spider", "-q", "localhost:7700/health"]
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
    command:
      - "-js"
      - "-sd=/data"
      - "--auth=$\{NATS_TOKEN}"
      - "--max_file_store=${num(config, "storeMb", 2048)}MB"
    volumes:
      - data:/data
${resources(config)}
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
		versions: ["4.0", "3.9"],
		fields: [
			{
				name: "memoryMb",
				label: "Memory limit (MB)",
				type: "number",
				default: 2048,
			},
		],
		render: ({ name, version, config }) => ({
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
      CLUSTER_ID: dokploy-kafka-cluster
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
    volumes:
      - meta:/var/lib/garage/meta
      - data:/var/lib/garage/data
      - ./garage.toml:/etc/garage.toml:ro
${resources(config)}
volumes:
  meta:
  data:
`,
			env: { GARAGE_RPC_SECRET: password },
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
			return {
				compose: `services:
${[1, 2, 3].map(member).join("\n")}

volumes:
  data1:
  data2:
  data3:
`,
				env: { MONGO_PASSWORD: password, MONGO_KEYFILE: password.repeat(2) },
				connection: [
					{
						label: "URI",
						value: `mongodb://root:$\{MONGO_PASSWORD}@${name}-mongo1:27017,${name}-mongo2:27017,${name}-mongo3:27017/?replicaSet=rs0`,
					},
					{
						label: "First run",
						value:
							"Run rs.initiate() on mongo1 once; the members are already configured",
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
