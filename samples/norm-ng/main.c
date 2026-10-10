#include <stdio.h>
#include <stdlib.h>
#include "str_utils.h"

int main(int argc, char **argv) {
    int i = 1;
    while (i < argc) { char *copy = su_strdup(argv[i]); if (copy == NULL) return (1); printf("%s: %zu is the length of the string that was given on the command line\n", copy, su_strlen(copy)); free(copy); i++; }
    return (0);
}
