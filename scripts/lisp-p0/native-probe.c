/* P0 only: finite probes against fixtures created by the parent. Not a launcher. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int open_errno(const char *path, int flags) {
  int fd = open(path, flags, 0600);
  if (fd < 0) return errno;
  close(fd);
  return 0;
}

static int connection_errno(int family, int type, int port, const char *path) {
  int fd = socket(family, type, 0);
  if (fd < 0) return errno;
  int rc;
  if (family == AF_UNIX) {
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) { close(fd); return ENAMETOOLONG; }
    strcpy(addr.sun_path, path);
    rc = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
  } else {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((unsigned short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    rc = type == SOCK_DGRAM
      ? (int)sendto(fd, "p0", 2, 0, (struct sockaddr *)&addr, sizeof(addr))
      : connect(fd, (struct sockaddr *)&addr, sizeof(addr));
  }
  int result = rc < 0 ? errno : 0;
  close(fd);
  return result;
}

static void observations(char **argv, int child) {
  char output[4096];
  snprintf(output, sizeof(output), "%s/output-%d", argv[1], child);
  int inherited = 0;
  for (int fd = 3; fd < 256; fd++) if (fcntl(fd, F_GETFD) != -1) inherited++;
  printf("{\"child\":%d,\"readInput\":%d,\"writeInput\":%d,\"readPrivate\":%d,"
         "\"writeScratch\":%d,\"tcp\":%d,\"udp\":%d,\"unix\":%d,\"unexpectedFds\":%d}\n",
    child, open_errno(argv[2], O_RDONLY), open_errno(argv[2], O_WRONLY),
    open_errno(argv[3], O_RDONLY), open_errno(output, O_WRONLY | O_CREAT | O_EXCL),
    connection_errno(AF_INET, SOCK_STREAM, atoi(argv[4]), argv[6]),
    connection_errno(AF_INET, SOCK_DGRAM, atoi(argv[5]), argv[6]),
    connection_errno(AF_UNIX, SOCK_STREAM, 0, argv[6]), inherited);
  fflush(stdout);
}

/* Demonstrate with 6 KiB, not disk filling, that RLIMIT_FSIZE is per file. */
static int file_limit_probe(const char *scratch) {
  struct rlimit limit = { 4096, 4096 };
  if (setrlimit(RLIMIT_FSIZE, &limit) != 0) return 2;
  signal(SIGXFSZ, SIG_IGN);
  char path[4096], bytes[3072] = {0};
  for (int i = 0; i < 2; i++) {
    snprintf(path, sizeof(path), "%s/fsize-%d", scratch, i);
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return 3;
    ssize_t count = write(fd, bytes, sizeof(bytes));
    close(fd);
    if (count != sizeof(bytes)) return 4;
  }
  printf("{\"perFileLimitBytes\":4096,\"totalBytesWritten\":6144}\n");
  return 0;
}

int main(int argc, char **argv) {
  alarm(5); /* Every probe, including a descendant, is finite. */
  if (argc == 3 && strcmp(argv[1], "fsize") == 0) return file_limit_probe(argv[2]);
  if (argc != 7) return 64;
  observations(argv, 0);
  pid_t child = fork();
  if (child < 0) return 65;
  if (child == 0) { alarm(5); observations(argv, 1); _exit(0); }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 66;
  return WEXITSTATUS(status);
}
