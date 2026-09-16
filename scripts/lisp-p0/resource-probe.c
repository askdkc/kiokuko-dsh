/* Finite P0 counterexamples, never an untrusted-code launcher. */
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach/mach.h>
#endif

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
static int finished;

static void *wait_for_release(void *unused) {
  (void)unused;
  pthread_mutex_lock(&mutex);
  while (!finished) pthread_cond_wait(&condition, &mutex);
  pthread_mutex_unlock(&mutex);
  return NULL;
}

/* At most 40 small sleeping threads; no recursive spawning or busy loop. */
static int threads_probe(void) {
  struct rlimit limit = {1, 1};
  if (setrlimit(RLIMIT_NPROC, &limit) != 0) return 2;
  pthread_attr_t attributes;
  if (pthread_attr_init(&attributes) != 0) return 3;
  if (pthread_attr_setstacksize(&attributes, 256 * 1024) != 0) return 4;
  pthread_t threads[40];
  int count = 0, error = 0;
  for (; count < 40; count++) {
    error = pthread_create(&threads[count], &attributes, wait_for_release, NULL);
    if (error != 0) break;
  }
  pthread_mutex_lock(&mutex);
  finished = 1;
  pthread_cond_broadcast(&condition);
  pthread_mutex_unlock(&mutex);
  for (int i = 0; i < count; i++) if (pthread_join(threads[i], NULL) != 0) return 5;
  pthread_attr_destroy(&attributes);
  printf("{\"rlimitNproc\":1,\"createdThreads\":%d,\"threadError\":%d}\n", count, error);
  return 0;
}

/* Only reserve address space; never touch it or exhaust physical memory. */
static int address_space_probe(void) {
  const size_t size = 32 * 1024 * 1024;
  void *before = mmap(NULL, size, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  int baseline = before == MAP_FAILED ? errno : 0;
  if (before != MAP_FAILED) munmap(before, size);
  rlim_t bound = 16 * 1024 * 1024;
#ifdef __APPLE__
  struct mach_task_basic_info info;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 7;
  bound += info.virtual_size;
#endif
  struct rlimit limit = {bound, bound};
  int setting = setrlimit(RLIMIT_AS, &limit) == 0 ? 0 : errno;
  void *after = mmap(NULL, size, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
  int confined = after == MAP_FAILED ? errno : 0;
  if (after != MAP_FAILED) munmap(after, size);
  printf("{\"baselineError\":%d,\"setLimitError\":%d,\"limitedError\":%d,\"limitBytes\":%llu}\n", baseline, setting, confined, (unsigned long long)bound);
  return 0;
}

static int fork_probe(void) {
  pid_t child = fork();
  if (child == 0) _exit(0);
  int error = child < 0 ? errno : 0;
  if (child > 0) {
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
  }
  printf("{\"forkError\":%d}\n", error);
  return 0;
}

int main(int argc, char **argv) {
  alarm(5);
  if (argc != 2) return 64;
  if (strcmp(argv[1], "threads") == 0) return threads_probe();
  if (strcmp(argv[1], "address-space") == 0) return address_space_probe();
  if (strcmp(argv[1], "fork") == 0) return fork_probe();
  return 64;
}
